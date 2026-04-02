import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';
import * as fs from 'fs';
import * as path from 'path';

type Mode = 'script' | 'direct';
type PackageManager = 'npm' | 'yarn' | 'pnpm';

export class JestRunner implements TestRunner {
  /**
   * Optional explicit override for the Jest command.
   * When empty (default), the runner auto-detects from package.json and node_modules.
   */
  private jestCommand: string;
  private mode: Mode = 'direct';
  private projectRoot?: string;
  private child?: ChildProcessWithoutNullStreams;

  // CRA / react-scripts projects must always use the npm script — never direct jest
  private forceScript = false;

  constructor(jestCommand: string = '') {
    this.jestCommand = jestCommand;
  }

  // -------------------------
  // Public API
  // -------------------------

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.ensureMode(projectRoot);

    // 1. Try via the project's own test script (most accurate — honours jest config baked into script)
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
      // CRA must not fall back to direct jest — it will break JSX transforms
      if (this.forceScript) throw e;
    }

    // 2. Try direct jest binary (auto-detected or user-specified)
    try {
      const result = await this.runJest(['--listTests', '--passWithNoTests'], projectRoot, 'direct');
      if (!result.passed) throw new Error(result.errors.join('\n'));
      const found = this.parseListTestsOutput(result.output);
      if (found.length > 0) return found;
    } catch { /* fall through */ }

    // 3. Last-resort: filesystem scan
    return this.discoverTestsFromFilesystem(projectRoot);
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    this.ensureMode(projectRoot);
    const coverageArgs = withCoverage
      ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
      : [];

    if (this.forceScript) {
      // CRA: prefer dedicated coverage script if it exists
      if (withCoverage && this.hasNpmScript(projectRoot, 'coverage')) {
        return this.runScript(projectRoot, 'coverage');
      }
      return this.runJest([...this.baseNonInteractiveArgs(), ...coverageArgs], projectRoot, 'script');
    }

    return this.runJest([...this.baseNonInteractiveArgs(), ...coverageArgs], projectRoot);
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

  // -------------------------
  // Mode / project detection
  // -------------------------

  private ensureMode(projectRoot: string) {
    this.projectRoot = projectRoot;

    const pkg = this.readPackageJson(projectRoot);
    const testScript = (pkg?.scripts?.test ?? '') as string;
    const hasTestScript = testScript.trim().length > 0;

    // CRA: react-scripts in the test script or in dependencies
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const isCRA =
      testScript.includes('react-scripts test') ||
      typeof deps['react-scripts'] === 'string';

    this.forceScript = isCRA;
    this.mode = (isCRA || hasTestScript) ? 'script' : 'direct';
  }

  /**
   * Detects the package manager used by the project by checking for lock files.
   * Falls back to npm if none are found.
   */
  private detectPackageManager(projectRoot: string): PackageManager {
    if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  private hasNpmScript(projectRoot: string, name: string): boolean {
    const pkg = this.readPackageJson(projectRoot);
    return Boolean(pkg?.scripts && typeof pkg.scripts[name] === 'string');
  }

  // -------------------------
  // Execution
  // -------------------------

  private baseNonInteractiveArgs(): string[] {
    return ['--watchAll=false'];
  }

  /**
   * Runs a named npm/yarn/pnpm script (e.g. "coverage").
   */
  private async runScript(projectRoot: string, scriptName: string): Promise<TestResult> {
    const pm = this.detectPackageManager(projectRoot);
    const cmd = this.platformCmd(pm);
    const cmdArgs = pm === 'yarn' ? [scriptName] : ['run', scriptName];
    return this.spawnToResult(cmd, cmdArgs, projectRoot);
  }

  private async runJest(args: string[], cwd: string, overrideMode?: Mode): Promise<TestResult> {
    const mode = overrideMode ?? this.mode;

    if (mode === 'script') {
      // Use the project's package manager and test script, appending our jest args after '--'
      const pm = this.detectPackageManager(cwd);
      const cmd = this.platformCmd(pm);
      // npm/pnpm: "run test -- ...args"
      // yarn: "test -- ...args"  (yarn passes args through without needing 'run')
      const cmdArgs = pm === 'yarn'
        ? ['test', '--', ...args]
        : ['run', 'test', '--', ...args];
      return this.spawnToResult(cmd, cmdArgs, cwd);
    }

    const { cmd, cmdArgs } = this.buildDirectCommand(args);
    return this.spawnToResult(cmd, cmdArgs, cwd);
  }

  private spawnToResult(cmd: string, cmdArgs: string[], cwd: string): Promise<TestResult> {
    this.killProcesses();

    return new Promise((resolve) => {
      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: false,
        env: {
          ...process.env,
          CI: 'true', // keeps CRA / react-scripts non-interactive
        },
      });

      this.child = child;

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('close', (code) => {
        this.child = undefined;
        const passed = code === 0;
        resolve({
          passed,
          output: stdout + stderr,
          errors: passed ? [] : [stderr || `Process exited with code ${code}`],
        });
      });

      child.on('error', (err) => {
        this.child = undefined;
        resolve({ passed: false, output: '', errors: [err.message] });
      });
    });
  }

  // -------------------------
  // Utils
  // -------------------------

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
    // 1. Explicit user override
    if (this.jestCommand) {
      const parts = this.splitCommand(this.jestCommand);
      const cmdRaw = parts.shift() || 'node';
      return { cmd: this.platformCmd(cmdRaw), cmdArgs: [...parts, ...extraArgs] };
    }

    const root = this.projectRoot || process.cwd();

    // 2. Local .bin/jest (standard npm/yarn/pnpm install location)
    const localBin = path.join(root, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localBin) || fs.existsSync(localBin + '.cmd')) {
      return { cmd: this.platformCmd(localBin), cmdArgs: extraArgs };
    }

    // 3. Legacy direct path
    const legacyBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');
    if (fs.existsSync(legacyBin)) {
      return { cmd: 'node', cmdArgs: [legacyBin, ...extraArgs] };
    }

    // 4. Last resort
    return { cmd: this.platformCmd('npx'), cmdArgs: ['jest', ...extraArgs] };
  }

  private platformCmd(bin: string): string {
    if (process.platform === 'win32') {
      const lower = bin.toLowerCase();
      if (!lower.endsWith('.cmd') && !lower.endsWith('.exe')) return `${bin}.cmd`;
    }
    return bin;
  }

  private parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes('/') || l.includes(path.sep));
  }

  private splitCommand(command: string): string[] {
    const out: string[] = [];
    let cur = '';
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
        cur = '';
        continue;
      }
      cur += ch;
    }

    if (cur) out.push(cur);
    return out;
  }

  private readPackageJson(projectRoot: string): any | undefined {
    const p = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
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
          if (
            item.startsWith('.') ||
            item === 'node_modules' ||
            item === 'build' ||
            item === 'dist' ||
            item === 'out' ||
            item === 'coverage'
          ) continue;
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
