import { spawn, ChildProcess } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Mode = 'script' | 'direct';
type PackageManager = 'npm' | 'yarn' | 'pnpm';

// ── Structured output types (from --json flag) ──────────────────────────────

export interface JestTestCaseResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped';
  duration?: number;
  failureMessages: string[];
}

export interface JestFileResult {
  testFilePath: string;
  status: 'passed' | 'failed';
  testCases: JestTestCaseResult[];
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
  private mode: Mode = 'direct';
  private projectRoot?: string;
  private child?: ChildProcess;
  private logger: (msg: string) => void;

  // CRA / react-scripts projects must always use the npm script — never direct jest
  private forceScript = false;

  constructor(jestCommand: string = '', logger: (msg: string) => void = () => {}) {
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
        [...this.baseNonInteractiveArgs(), '--listTests', '--passWithNoTests'],
        projectRoot
      );
      if (!result.passed) throw new Error(result.errors.join('\n'));
      const found = this.parseListTestsOutput(result.output);
      if (found.length > 0) return found;
      throw new Error('empty output');
    } catch (e) {
      if (this.forceScript) throw e;
    }

    try {
      const result = await this.runJest(['--listTests', '--passWithNoTests'], projectRoot, 'direct');
      if (!result.passed) throw new Error(result.errors.join('\n'));
      const found = this.parseListTestsOutput(result.output);
      if (found.length > 0) return found;
    } catch { /* fall through */ }

    return this.discoverTestsFromFilesystem(projectRoot);
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    this.ensureMode(projectRoot);
    const coverageArgs = withCoverage
      ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
      : [];

    if (this.forceScript) {
      if (withCoverage && this.hasNpmScript(projectRoot, 'coverage')) {
        return this.runScript(projectRoot, 'coverage');
      }
      return this.runJest([...this.baseNonInteractiveArgs(), ...coverageArgs], projectRoot, 'script');
    }

    return this.runJest([...this.baseNonInteractiveArgs(), ...coverageArgs], projectRoot);
  }

  /**
   * Runs the full suite and returns structured per-file / per-test-case results.
   * stderr (normal Jest output) is streamed to the logger in real time.
   * stdout (JSON) is parsed after the run completes.
   */
  async runFullSuiteJson(projectRoot: string, withCoverage: boolean = false): Promise<JestJsonResult> {
    this.ensureMode(projectRoot);
    const coverageArgs = withCoverage
      ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
      : [];

    if (this.forceScript && withCoverage && this.hasNpmScript(projectRoot, 'coverage')) {
      // coverage script won't produce --json on stdout, fall back to normal result
      const r = await this.runScript(projectRoot, 'coverage');
      return this.emptyJsonResult(r.passed, r.errors);
    }

    return this.runWithJsonCapture(
      [...this.baseNonInteractiveArgs(), '--json', ...coverageArgs],
      projectRoot
    );
  }

  /** Runs a single test file and returns structured test-case results. */
  async runTestFileJson(filePath: string): Promise<JestJsonResult> {
    const cwd = this.requireProjectRoot();
    return this.runWithJsonCapture(
      [...this.baseNonInteractiveArgs(), '--json', '--runTestsByPath', filePath],
      cwd
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
        [...this.baseNonInteractiveArgs(), '--json', '--runTestsByPath', ...filePaths],
        cwd
      );
    }

    // Run each chunk sequentially and merge results
    const results: JestJsonResult[] = [];
    for (const chunk of chunks) {
      results.push(await this.runWithJsonCapture(
        [...this.baseNonInteractiveArgs(), '--json', '--runTestsByPath', ...chunk],
        cwd
      ));
    }
    return this.mergeJsonResults(results);
  }

  private chunkByCommandLineLength(filePaths: string[], maxCharsForPaths = 5500): string[][] {
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
      passed: results.every(r => r.passed),
      numPassedTests:  results.reduce((s, r) => s + r.numPassedTests,  0),
      numFailedTests:  results.reduce((s, r) => s + r.numFailedTests,  0),
      numPendingTests: results.reduce((s, r) => s + r.numPendingTests, 0),
      fileResults: results.flatMap(r => r.fileResults),
      errors:      results.flatMap(r => r.errors),
    };
  }

  /** Runs --findRelatedTests for a source file and returns structured results. */
  async runRelatedTestsJson(filePath: string): Promise<JestJsonResult> {
    const cwd = this.requireProjectRoot();
    return this.runWithJsonCapture(
      [...this.baseNonInteractiveArgs(), '--json', '--findRelatedTests', filePath],
      cwd
    );
  }

  async runTestFile(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), '--runTestsByPath', filePath],
      cwd
    );
  }

  async runTestFiles(files: string[]): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), '--runTestsByPath', ...files],
      cwd
    );
  }

  async runRelatedTests(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    return this.runJest(
      [...this.baseNonInteractiveArgs(), '--findRelatedTests', filePath],
      cwd
    );
  }

  isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.');
  }

  async getCoverage(): Promise<any> {
    const cwd = this.requireProjectRoot();
    const p = path.join(cwd, 'coverage', 'coverage-final.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    return {};
  }

  killProcesses(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = undefined;
  }

  // ── Mode / project detection ───────────────────────────────────────────────

  private ensureMode(projectRoot: string) {
    this.projectRoot = projectRoot;

    const pkg = this.readPackageJson(projectRoot);
    const testScript = (pkg?.scripts?.test ?? '') as string;
    const hasTestScript = testScript.trim().length > 0;

    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const isCRA =
      testScript.includes('react-scripts test') ||
      typeof deps['react-scripts'] === 'string';

    this.forceScript = isCRA;
    this.mode = (isCRA || hasTestScript) ? 'script' : 'direct';
  }

  private detectPackageManager(projectRoot: string): PackageManager {
    if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private hasNpmScript(projectRoot: string, name: string): boolean {
    const pkg = this.readPackageJson(projectRoot);
    return Boolean(pkg?.scripts && typeof pkg.scripts[name] === 'string');
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  private baseNonInteractiveArgs(): string[] {
    // --watchAll=false: overrides --watch if baked into the project's test script
    // --forceExit: prevents Jest from hanging after tests complete
    return ['--watchAll=false', '--forceExit'];
  }

  private async runScript(projectRoot: string, scriptName: string): Promise<TestResult> {
    const pm = this.detectPackageManager(projectRoot);
    const cmd = this.platformCmd(pm);
    const cmdArgs = pm === 'yarn' ? [scriptName] : ['run', scriptName];
    return this.spawnToResult(cmd, cmdArgs, projectRoot);
  }

  private async runJest(args: string[], cwd: string, overrideMode?: Mode): Promise<TestResult> {
    const mode = overrideMode ?? this.mode;

    if (mode === 'script') {
      const pm = this.detectPackageManager(cwd);
      const cmd = this.platformCmd(pm);
      const cmdArgs = pm === 'yarn'
        ? ['test', '--', ...args]
        : ['run', 'test', '--', ...args];
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
  private async runWithJsonCapture(args: string[], cwd: string): Promise<JestJsonResult> {
    if (!fs.existsSync(cwd)) {
      return this.emptyJsonResult(false, [`Project root does not exist: ${cwd}`]);
    }

    // Unique temp file per invocation so concurrent runners never collide
    const tmpFile = path.join(os.tmpdir(), `jest-results-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const argsWithOutput = [...args, `--outputFile=${tmpFile}`];

    let cmd: string;
    let cmdArgs: string[];

    if (this.mode === 'script') {
      const pm = this.detectPackageManager(cwd);
      cmd = this.platformCmd(pm);
      cmdArgs = pm === 'yarn'
        ? ['test', '--', ...argsWithOutput]
        : ['run', 'test', '--', ...argsWithOutput];
    } else {
      const direct = this.buildDirectCommand(argsWithOutput);
      cmd = direct.cmd;
      cmdArgs = direct.cmdArgs;
    }

    this.logger(`> ${cmd} ${cmdArgs.join(' ')}`);
    this.killProcesses();

    const { passed, stderr } = await new Promise<{ passed: boolean; stderr: string }>((resolve) => {
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);

      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: useShell,
        env: { ...process.env, CI: 'true' },
      });

      this.child = child;
      child.stdin?.end();

      let stderr = '';
      let exitCode: number | null = null;
      let stderrEnded = !child.stderr;
      let resolved = false;

      const maybeResolve = () => {
        if (resolved || exitCode === null || !stderrEnded) return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: exitCode === 0, stderr });
      };

      // stdout is not used — JSON goes to the temp file
      child.stdout?.resume();

      child.stderr?.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stderr?.on('end', () => { stderrEnded = true; maybeResolve(); });

      child.on('exit', (code) => { exitCode = code ?? 1; maybeResolve(); });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, stderr: err.message });
      });
    });

    // Read JSON from the temp file — reliable even on Windows
    let jsonOutput = '';
    try {
      if (fs.existsSync(tmpFile)) {
        jsonOutput = fs.readFileSync(tmpFile, 'utf8');
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }

    return this.parseJestJson(passed, jsonOutput, stderr);
  }

  private spawnToResult(cmd: string, cmdArgs: string[], cwd: string): Promise<TestResult> {
    this.killProcesses();

    if (!fs.existsSync(cwd)) {
      return Promise.resolve({
        passed: false,
        output: '',
        errors: [`Project root does not exist: ${cwd}`],
      });
    }

    this.logger(`> ${cmd} ${cmdArgs.join(' ')}`);

    return new Promise((resolve) => {
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);

      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: useShell,
        env: { ...process.env, CI: 'true' },
      });

      this.child = child;
      child.stdin?.end();

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let stdoutEnded = !child.stdout;
      let stderrEnded = !child.stderr;
      let resolved = false;

      const maybeResolve = () => {
        if (resolved || exitCode === null || !stdoutEnded || !stderrEnded) return;
        resolved = true;
        this.child = undefined;
        const passed = exitCode === 0;
        resolve({
          passed,
          output: stdout + stderr,
          errors: passed ? [] : [stderr || `Process exited with code ${exitCode}`],
        });
      };

      child.stdout?.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stdout?.on('end', () => { stdoutEnded = true; maybeResolve(); });

      child.stderr?.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stderr?.on('end', () => { stderrEnded = true; maybeResolve(); });

      child.on('exit', (code) => { exitCode = code ?? 1; maybeResolve(); });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, output: '', errors: [err.message] });
      });
    });
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  private parseJestJson(passed: boolean, raw: string, stderr: string): JestJsonResult {
    try {
      const json = JSON.parse(raw);
      return {
        passed,
        numPassedTests: json.numPassedTests ?? 0,
        numFailedTests: json.numFailedTests ?? 0,
        numPendingTests: json.numPendingTests ?? 0,
        fileResults: (json.testResults ?? []).map((fr: any): JestFileResult => {
          const testCases = (fr.testResults ?? []).map((tc: any): JestTestCaseResult => ({
            ancestorTitles: tc.ancestorTitles ?? [],
            title: tc.title ?? '',
            fullName: tc.fullName ?? '',
            status: tc.status ?? 'failed',
            duration: tc.duration,
            failureMessages: tc.failureMessages ?? [],
          }));
          const duration = testCases.reduce((sum: number, tc: JestTestCaseResult) => sum + (tc.duration || 0), 0);
          return {
            testFilePath: fr.testFilePath ?? '',
            status: fr.status === 'passed' ? 'passed' : 'failed',
            failureMessage: fr.failureMessage || undefined,
            testCases,
            duration: duration > 0 ? duration : undefined,
          };
        }),
        errors: passed ? [] : [stderr || 'Tests failed'],
      };
    } catch {
      // JSON parse failed — Jest likely printed an error before producing output
      return this.emptyJsonResult(false, [stderr || raw || 'Jest failed to produce JSON output']);
    }
  }

  private emptyJsonResult(passed: boolean, errors: string[]): JestJsonResult {
    return { passed, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, fileResults: [], errors };
  }

  private parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes('/') || l.includes(path.sep));
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
      const cmdRaw = parts.shift() || 'node';
      return { cmd: this.platformCmd(cmdRaw), cmdArgs: [...parts, ...extraArgs] };
    }

    const root = this.projectRoot || process.cwd();

    const localBin = path.join(root, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localBin) || fs.existsSync(localBin + '.cmd')) {
      return { cmd: this.platformCmd(localBin), cmdArgs: extraArgs };
    }

    const legacyBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');
    if (fs.existsSync(legacyBin)) {
      return { cmd: 'node', cmdArgs: [legacyBin, ...extraArgs] };
    }

    return { cmd: this.platformCmd('npx'), cmdArgs: ['jest', ...extraArgs] };
  }

  private platformCmd(bin: string): string {
    if (process.platform === 'win32') {
      const lower = bin.toLowerCase();
      if (!lower.endsWith('.cmd') && !lower.endsWith('.exe')) return `${bin}.cmd`;
    }
    return bin;
  }

  private splitCommand(command: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      if (!inQuotes && (ch === '"' || ch === "'")) { inQuotes = true; quote = ch as '"' | "'"; continue; }
      if (inQuotes && ch === quote) { inQuotes = false; quote = null; continue; }
      if (!inQuotes && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  private readPackageJson(projectRoot: string): any | undefined {
    const p = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(p)) return undefined;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return undefined; }
  }

  private discoverTestsFromFilesystem(projectRoot: string): string[] {
    const testFiles: string[] = [];

    const scan = (dir: string) => {
      let items: string[] = [];
      try { items = fs.readdirSync(path.join(projectRoot, dir)); } catch { return; }

      for (const item of items) {
        const rel = path.join(dir, item);
        const abs = path.join(projectRoot, rel);

        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { continue; }

        if (st.isDirectory()) {
          if (item.startsWith('.') || ['node_modules','build','dist','out','coverage'].includes(item)) continue;
          scan(rel);
        } else if (st.isFile()) {
          if (item.includes('.test.') || item.includes('.spec.')) testFiles.push(abs);
        }
      }
    };

    scan('');
    return testFiles;
  }

  private requireProjectRoot(): string {
    if (!this.projectRoot) throw new Error('projectRoot not set — call discoverTests(projectRoot) first.');
    return this.projectRoot;
  }
}
