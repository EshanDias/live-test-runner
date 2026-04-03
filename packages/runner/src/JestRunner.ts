import { spawn, ChildProcess } from "child_process";
import { TestRunner, TestResult } from "./TestRunner";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Mode = "script" | "direct";
type PackageManager = "npm" | "yarn" | "pnpm";

// ── Structured output types (from --json flag) ──────────────────────────────

export interface JestTestCaseResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: "passed" | "failed" | "pending" | "todo" | "skipped";
  duration?: number;
  failureMessages: string[];
}

export interface JestConsoleEntry {
  message: string;
  /** Jest console type: 'log' | 'warn' | 'error' | 'info' | 'debug' | etc. */
  type: string;
  origin: string;
}

export interface JestFileResult {
  testFilePath: string;
  status: "passed" | "failed";
  testCases: JestTestCaseResult[];
  /** Console output captured during this file's run */
  consoleOutput: JestConsoleEntry[];
  /** Populated when the file itself fails to compile/parse */
  failureMessage?: string;
  /** Total execution time for this file in milliseconds */
  duration?: number;
}

export interface JestJsonResult {
  passed: boolean;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  fileResults: JestFileResult[];
  errors: string[];
}

// ────────────────────────────────────────────────────────────────────────────

export class JestRunner implements TestRunner {
  /**
   * Optional explicit override for the Jest command.
   * When empty (default), the runner auto-detects from package.json and node_modules.
   */
  private jestCommand: string;
  private mode: Mode = "direct";
  private projectRoot?: string;
  private child?: ChildProcess;
  private logger: (msg: string) => void;

  // CRA / react-scripts projects must always use the npm script — never direct jest
  private forceScript = false;

  constructor(
    jestCommand: string = "",
    logger: (msg: string) => void = () => {},
  ) {
    this.jestCommand = jestCommand;
    this.logger = logger;
  }

  /** Replace the logger at runtime (e.g. to wire a TestRun's appendOutput into live output). */
  setLogger(logger: (msg: string) => void) {
    this.logger = logger;
  }

  /** Set the project root directly (also detects CRA / script mode). */
  setProjectRoot(root: string) {
    this.ensureMode(root);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.ensureMode(projectRoot);

    try {
      const result = await this.runJest(
        [...this.baseNonInteractiveArgs(), "--listTests", "--passWithNoTests"],
        projectRoot,
      );
      if (!result.passed) throw new Error(result.errors.join("\n"));
      const found = this.parseListTestsOutput(result.output);
      if (found.length > 0) return found;
      throw new Error("empty output");
    } catch (e) {
      if (this.forceScript) throw e;
    }

    try {
      const result = await this.runJest(
        ["--listTests", "--passWithNoTests"],
        projectRoot,
        "direct",
      );
      if (!result.passed) throw new Error(result.errors.join("\n"));
      const found = this.parseListTestsOutput(result.output);
      if (found.length > 0) return found;
    } catch {
      /* fall through */
    }

    return this.discoverTestsFromFilesystem(projectRoot);
  }

  async runFullSuite(
    projectRoot: string,
    withCoverage: boolean = false,
  ): Promise<TestResult> {
    this.ensureMode(projectRoot);
    const coverageArgs = withCoverage
      ? [
          "--coverage",
          "--coverageReporters=json",
          "--coverageReporters=json-summary",
        ]
      : [];

    if (this.forceScript) {
      if (withCoverage && this.hasNpmScript(projectRoot, "coverage")) {
        return this.runScript(projectRoot, "coverage");
      }
      return this.runJest(
        [...this.baseNonInteractiveArgs(), ...coverageArgs],
        projectRoot,
        "script",
      );
    }

    return this.runJest(
      [...this.baseNonInteractiveArgs(), ...coverageArgs],
      projectRoot,
    );
  }

  /**
   * Runs the full suite and returns structured per-file / per-test-case results.
   * stderr (normal Jest output) is streamed to the logger in real time.
   * stdout (JSON) is parsed after the run completes.
   */
  async runFullSuiteJson(
    projectRoot: string,
    withCoverage: boolean = false,
  ): Promise<JestJsonResult> {
    this.ensureMode(projectRoot);
    const coverageArgs = withCoverage
      ? [
          "--coverage",
          "--coverageReporters=json",
          "--coverageReporters=json-summary",
        ]
      : [];

    if (
      this.forceScript &&
      withCoverage &&
      this.hasNpmScript(projectRoot, "coverage")
    ) {
      // coverage script won't produce --json on stdout, fall back to normal result
      const r = await this.runScript(projectRoot, "coverage");
      return this.emptyJsonResult(r.passed, r.errors);
    }

    return this.runWithJsonCapture(
      [...this.baseNonInteractiveArgs(), "--json", ...coverageArgs],
      projectRoot,
    );
  }

  /** Runs a single test file and returns structured test-case results. */
  async runTestFileJson(filePath: string): Promise<JestJsonResult> {
    const cwd = this.requireProjectRoot();
    return this.runWithJsonCapture(
      [
        ...this.baseNonInteractiveArgs(),
        "--json",
        "--runTestsByPath",
        filePath,
      ],
      cwd,
    );
  }

  /** Runs multiple test files in a single Jest invocation (parallel workers).
   *  Automatically chunks into multiple invocations if the command line would exceed
   *  the Windows 8191-character limit. Chunk results are merged transparently. */
  async runTestFilesJson(filePaths: string[]): Promise<JestJsonResult> {
    if (filePaths.length === 0) return this.emptyJsonResult(true, []);
    if (filePaths.length === 1) return this.runTestFileJson(filePaths[0]);

    const chunks = this.chunkByCommandLineLength(filePaths);
    const cwd = this.requireProjectRoot();

    if (chunks.length === 1) {
      return this.runWithJsonCapture(
        [
          ...this.baseNonInteractiveArgs(),
          "--json",
          "--runTestsByPath",
          ...filePaths,
        ],
        cwd,
      );
    }

    // Run each chunk sequentially and merge results
    const results: JestJsonResult[] = [];
    for (const chunk of chunks) {
      results.push(
        await this.runWithJsonCapture(
          [
            ...this.baseNonInteractiveArgs(),
            "--json",
            "--runTestsByPath",
            ...chunk,
          ],
          cwd,
        ),
      );
    }
    return this.mergeJsonResults(results);
  }

  private chunkByCommandLineLength(
    filePaths: string[],
    maxCharsForPaths = 5500,
  ): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (const fp of filePaths) {
      const len = fp.length + 1; // +1 for space separator
      if (current.length > 0 && currentLen + len > maxCharsForPaths) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(fp);
      currentLen += len;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private mergeJsonResults(results: JestJsonResult[]): JestJsonResult {
    return {
      passed: results.every((r) => r.passed),
      numPassedTests: results.reduce((s, r) => s + r.numPassedTests, 0),
      numFailedTests: results.reduce((s, r) => s + r.numFailedTests, 0),
      numPendingTests: results.reduce((s, r) => s + r.numPendingTests, 0),
      fileResults: results.flatMap((r) => r.fileResults),
      errors: results.flatMap((r) => r.errors),
    };
  }

  /** Runs --findRelatedTests for a source file and returns structured results. */
  async runRelatedTestsJson(filePath: string): Promise<JestJsonResult> {
    const cwd = this.requireProjectRoot();
    return this.runWithJsonCapture(
      [
        ...this.baseNonInteractiveArgs(),
        "--json",
        "--findRelatedTests",
        filePath,
      ],
      cwd,
    );
  }

  async runTestFile(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), "--runTestsByPath", filePath],
      cwd,
    );
  }

  async runTestFiles(files: string[]): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), "--runTestsByPath", ...files],
      cwd,
    );
  }

  async runRelatedTests(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), "--findRelatedTests", filePath],
      cwd,
    );
  }

  isTestFile(filePath: string): boolean {
    return filePath.includes(".test.") || filePath.includes(".spec.");
  }

  async getCoverage(): Promise<any> {
    const cwd = this.requireProjectRoot();
    const p = path.join(cwd, "coverage", "coverage-final.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    return {};
  }

  killProcesses(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.child = undefined;
  }

  // ── Mode / project detection ───────────────────────────────────────────────

  private ensureMode(projectRoot: string) {
    this.projectRoot = projectRoot;

    const pkg = this.readPackageJson(projectRoot);
    const testScript = (pkg?.scripts?.test ?? "") as string;
    const hasTestScript = testScript.trim().length > 0;

    const deps = {
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
    };
    const isCRA =
      testScript.includes("react-scripts test") ||
      typeof deps["react-scripts"] === "string";

    this.forceScript = isCRA;
    this.mode = isCRA || hasTestScript ? "script" : "direct";
  }

  private detectPackageManager(projectRoot: string): PackageManager {
    if (fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(projectRoot, "yarn.lock"))) return "yarn";
    return "npm";
  }

  private hasNpmScript(projectRoot: string, name: string): boolean {
    const pkg = this.readPackageJson(projectRoot);
    return Boolean(pkg?.scripts && typeof pkg.scripts[name] === "string");
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  private baseNonInteractiveArgs(): string[] {
    // --watchAll=false: overrides --watch if baked into the project's test script
    // --forceExit: prevents Jest from hanging after tests complete
    // '--no-bail': ensures Jest runs all tests even if some fail (important for full-suite runs)
    return ["--watchAll=false", "--forceExit", "--no-bail"];
  }

  private async runScript(
    projectRoot: string,
    scriptName: string,
  ): Promise<TestResult> {
    const pm = this.detectPackageManager(projectRoot);
    const cmd = this.platformCmd(pm);
    const cmdArgs = pm === "yarn" ? [scriptName] : ["run", scriptName];
    return this.spawnToResult(cmd, cmdArgs, projectRoot);
  }

  private async runJest(
    args: string[],
    cwd: string,
    overrideMode?: Mode,
  ): Promise<TestResult> {
    const mode = overrideMode ?? this.mode;

    if (mode === "script") {
      const pm = this.detectPackageManager(cwd);
      const cmd = this.platformCmd(pm);
      const cmdArgs =
        pm === "yarn"
          ? ["test", "--", ...args]
          : ["run", "test", "--", ...args];
      return this.spawnToResult(cmd, cmdArgs, cwd);
    }

    const { cmd, cmdArgs } = this.buildDirectCommand(args);
    return this.spawnToResult(cmd, cmdArgs, cwd);
  }

  /**
   * Runs Jest with --json --outputFile=<tmpfile>. stderr (readable test output) is streamed
   * live to the logger. JSON is read from the temp file after the process exits — this is
   * immune to Windows pipe-buffering issues that can cause stdout capture to lose data.
   */
  private async runWithJsonCapture(
    args: string[],
    cwd: string,
  ): Promise<JestJsonResult> {
    if (!fs.existsSync(cwd)) {
      return this.emptyJsonResult(false, [
        `Project root does not exist: ${cwd}`,
      ]);
    }

    // Unique temp file per invocation so concurrent runners never collide
    const tmpFile = path.join(
      os.tmpdir(),
      `jest-results-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    const argsWithOutput = [...args, `--outputFile=${tmpFile}`];

    let cmd: string;
    let cmdArgs: string[];

    if (this.mode === "script") {
      const pm = this.detectPackageManager(cwd);
      cmd = this.platformCmd(pm);
      cmdArgs =
        pm === "yarn"
          ? ["test", "--", ...argsWithOutput]
          : ["run", "test", "--", ...argsWithOutput];
    } else {
      const direct = this.buildDirectCommand(argsWithOutput);
      cmd = direct.cmd;
      cmdArgs = direct.cmdArgs;
    }

    this.logger(`> ${cmd} ${cmdArgs.join(" ")}`);
    this.killProcesses();

    const { passed, stdout, stderr } = await new Promise<{
      passed: boolean;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const useShell =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);

      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: useShell,
        env: { ...process.env, CI: "true" },
      });

      this.child = child;
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let stdoutEnded = !child.stdout;
      let stderrEnded = !child.stderr;
      let resolved = false;

      const maybeResolve = () => {
        if (resolved || exitCode === null || !stdoutEnded || !stderrEnded)
          return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: exitCode === 0, stdout, stderr });
      };

      // Capture stdout — it carries the --json output as a fallback when --outputFile is not written
      // (CRA/react-scripts may skip the outputFile on a bailed/failed run)
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stdout?.on("end", () => {
        stdoutEnded = true;
        maybeResolve();
      });

      child.stderr?.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stderr?.on("end", () => {
        stderrEnded = true;
        maybeResolve();
      });

      child.on("exit", (code) => {
        exitCode = code ?? 1;
        maybeResolve();
      });

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, stdout: "", stderr: err.message });
      });
    });

    // Prefer the outputFile (immune to Windows pipe buffering); fall back to captured stdout
    // for cases where CRA skips writing the file on a bailed/failed run.
    let jsonOutput = "";
    try {
      if (fs.existsSync(tmpFile)) {
        jsonOutput = fs.readFileSync(tmpFile, "utf8");
      }
      if (!jsonOutput.trim()) {
        jsonOutput = stdout;
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }

    return this.parseJestJson(passed, jsonOutput, stderr);
  }

  private spawnToResult(
    cmd: string,
    cmdArgs: string[],
    cwd: string,
  ): Promise<TestResult> {
    this.killProcesses();

    if (!fs.existsSync(cwd)) {
      return Promise.resolve({
        passed: false,
        output: "",
        errors: [`Project root does not exist: ${cwd}`],
      });
    }

    this.logger(`> ${cmd} ${cmdArgs.join(" ")}`);

    return new Promise((resolve) => {
      const useShell =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);

      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: useShell,
        env: { ...process.env, CI: "true" },
      });

      this.child = child;
      child.stdin?.end();

      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let stdoutEnded = !child.stdout;
      let stderrEnded = !child.stderr;
      let resolved = false;

      const maybeResolve = () => {
        if (resolved || exitCode === null || !stdoutEnded || !stderrEnded)
          return;
        resolved = true;
        this.child = undefined;
        const passed = exitCode === 0;
        resolve({
          passed,
          output: stdout + stderr,
          errors: passed
            ? []
            : [stderr || `Process exited with code ${exitCode}`],
        });
      };

      child.stdout?.on("data", (d) => {
        const chunk = d.toString();
        stdout += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stdout?.on("end", () => {
        stdoutEnded = true;
        maybeResolve();
      });

      child.stderr?.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stderr?.on("end", () => {
        stderrEnded = true;
        maybeResolve();
      });

      child.on("exit", (code) => {
        exitCode = code ?? 1;
        maybeResolve();
      });

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, output: "", errors: [err.message] });
      });
    });
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  private minimal(failureMessages: string[] = []) {
    try {
      return failureMessages.map((msg) => {
        const lines = msg.split("\n");
        const stackIndex = lines.findIndex((line) =>
          line.trim().startsWith("at "),
        );
        return lines
          .slice(0, stackIndex === -1 ? lines.length : stackIndex)
          .join("\n");
      });
    } catch (error) {
      return [];
    }
  }

  private parseJestJson(
    passed: boolean,
    raw: string,
    stderr: string,
  ): JestJsonResult {
    try {
      const json = JSON.parse(raw);
      const fileResults: JestFileResult[] = (json.testResults ?? []).map(
        (fr: any): JestFileResult => {
          const testCases = (fr.testResults ?? fr.assertionResults ?? []).map(
            (tc: any): JestTestCaseResult => ({
              ancestorTitles: tc.ancestorTitles ?? [],
              title: tc.title ?? "",
              fullName: tc.fullName ?? "",
              status: tc.status ?? "failed",
              duration: tc.duration,
              failureMessages: this.minimal(tc.failureMessages) ?? [],
            }),
          );
          let fileDuration = testCases.reduce(
            (sum: number, tc: JestTestCaseResult) => sum + (tc.duration || 0),
            0,
          );
          fileDuration =
            fileDuration === 0 && fr.endTime && fr.startTime
              ? fr.endTime - fr.startTime
              : 0;
          const consoleOutput: JestConsoleEntry[] = (fr.console ?? []).map(
            (c: any) => ({
              message: String(c.message ?? ""),
              type: String(c.type ?? "log"),
              origin: String(c.origin ?? ""),
            }),
          );
          return {
            testFilePath: fr.testFilePath ?? "",
            status: fr.status === "passed" ? "passed" : "failed",
            failureMessage: fr.failureMessage || undefined,
            testCases,
            consoleOutput,
            duration: fileDuration > 0 ? fileDuration : undefined,
          };
        },
      );

      // react-scripts omits fr.console from JSON — fall back to stderr parsing.
      // For single-file runs (the common case) we can attribute all entries to the one file.
      if (
        fileResults.length === 1 &&
        fileResults[0].consoleOutput.length === 0
      ) {
        fileResults[0].consoleOutput = this.parseConsoleFromStderr(stderr);
      }

      return {
        passed,
        numPassedTests: json.numPassedTests ?? 0,
        numFailedTests: json.numFailedTests ?? 0,
        numPendingTests: json.numPendingTests ?? 0,
        fileResults,
        errors: passed ? [] : [stderr || "Tests failed"],
      };
    } catch {
      // JSON parse failed — Jest likely printed an error before producing output
      return this.emptyJsonResult(false, [
        stderr || raw || "Jest failed to produce JSON output",
      ]);
    }
  }

  /**
   * Extracts console.log/warn/error/info/debug blocks from Jest's human-readable stderr.
   * Used as a fallback when the JSON output doesn't include a `console` array
   * (e.g. react-scripts / CRA projects).
   *
   * Jest stderr format per entry:
   *   "  console.TYPE\n    <message lines>\n\n      at origin (file:line)\n"
   */
  private parseConsoleFromStderr(stderr: string): JestConsoleEntry[] {
    const entries: JestConsoleEntry[] = [];
    const lines = stderr.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const header = lines[i].match(
        /^\s+console\.(log|error|warn|info|debug)\s*$/,
      );
      if (!header) {
        i++;
        continue;
      }

      const type = header[1];
      i++;

      const msgLines: string[] = [];
      let origin = "";

      while (i < lines.length) {
        // Stop when we hit the next console.* header
        if (/^\s+console\.(log|error|warn|info|debug)\s*$/.test(lines[i]))
          break;
        // Stop at stack-trace "at" lines; capture the first as origin
        if (/^\s+at\s/.test(lines[i])) {
          if (!origin) origin = lines[i].trim();
          i++;
          // Skip remaining "at" lines
          while (i < lines.length && /^\s+at\s/.test(lines[i])) i++;
          break;
        }
        msgLines.push(lines[i]);
        i++;
      }

      // Trim leading/trailing blank lines from the message
      while (msgLines.length > 0 && msgLines[0].trim() === "") msgLines.shift();
      while (msgLines.length > 0 && msgLines[msgLines.length - 1].trim() === "")
        msgLines.pop();

      if (msgLines.length > 0) {
        entries.push({
          message: msgLines.map((l) => l.replace(/^\s{4}/, "")).join("\n"),
          type,
          origin,
        });
      }
    }

    return entries;
  }

  private emptyJsonResult(passed: boolean, errors: string[]): JestJsonResult {
    return {
      passed,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      fileResults: [],
      errors,
    };
  }

  private parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes("/") || l.includes(path.sep));
  }

  /**
   * Builds the command for direct jest execution.
   *
   * Priority:
   *  1. User-specified jestCommand override (from settings)
   *  2. node_modules/.bin/jest  (local install, most projects)
   *  3. node_modules/jest/bin/jest.js  (legacy path)
   *  4. npx jest  (last resort — may fail on restricted environments)
   */
  private buildDirectCommand(extraArgs: string[]) {
    if (this.jestCommand) {
      const parts = this.splitCommand(this.jestCommand);
      const cmdRaw = parts.shift() || "node";
      return {
        cmd: this.platformCmd(cmdRaw),
        cmdArgs: [...parts, ...extraArgs],
      };
    }

    const root = this.projectRoot || process.cwd();

    const localBin = path.join(root, "node_modules", ".bin", "jest");
    if (fs.existsSync(localBin) || fs.existsSync(localBin + ".cmd")) {
      return { cmd: this.platformCmd(localBin), cmdArgs: extraArgs };
    }

    const legacyBin = path.join(root, "node_modules", "jest", "bin", "jest.js");
    if (fs.existsSync(legacyBin)) {
      return { cmd: "node", cmdArgs: [legacyBin, ...extraArgs] };
    }

    return { cmd: this.platformCmd("npx"), cmdArgs: ["jest", ...extraArgs] };
  }

  private platformCmd(bin: string): string {
    if (process.platform === "win32") {
      const lower = bin.toLowerCase();
      if (!lower.endsWith(".cmd") && !lower.endsWith(".exe"))
        return `${bin}.cmd`;
    }
    return bin;
  }

  private splitCommand(command: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (!inQuotes && (ch === '"' || ch === "'")) {
        inQuotes = true;
        quote = ch as '"' | "'";
        continue;
      }
      if (inQuotes && ch === quote) {
        inQuotes = false;
        quote = null;
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) {
        if (cur) out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  private readPackageJson(projectRoot: string): any | undefined {
    const p = path.join(projectRoot, "package.json");
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return undefined;
    }
  }

  private discoverTestsFromFilesystem(projectRoot: string): string[] {
    const testFiles: string[] = [];

    const scan = (dir: string) => {
      let items: string[] = [];
      try {
        items = fs.readdirSync(path.join(projectRoot, dir));
      } catch {
        return;
      }

      for (const item of items) {
        const rel = path.join(dir, item);
        const abs = path.join(projectRoot, rel);

        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }

        if (st.isDirectory()) {
          if (
            item.startsWith(".") ||
            ["node_modules", "build", "dist", "out", "coverage"].includes(item)
          )
            continue;
          scan(rel);
        } else if (st.isFile()) {
          if (item.includes(".test.") || item.includes(".spec."))
            testFiles.push(abs);
        }
      }
    };

    scan("");
    return testFiles;
  }

  private requireProjectRoot(): string {
    if (!this.projectRoot)
      throw new Error(
        "projectRoot not set — call discoverTests(projectRoot) first.",
      );
    return this.projectRoot;
  }
}
