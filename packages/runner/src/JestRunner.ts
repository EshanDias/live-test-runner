import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';
import * as fs from 'fs';
import * as path from 'path';

type Mode = 'script' | 'direct';

export class JestRunner implements TestRunner {
  private jestCommand: string;
  private mode: Mode = 'direct';
  private projectRoot?: string;
  private child?: ChildProcessWithoutNullStreams;

  // If true, we NEVER use direct jest (CRA/react-scripts needs its transform)
  private forceScript = false;

  constructor(jestCommand: string = 'npx jest') {
    this.jestCommand = jestCommand;
  }

  // -------------------------
  // Public API
  // -------------------------

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.ensureMode(projectRoot);

    // Prefer authoritative discovery
    try {
      const result = await this.runJest(
        [...this.baseNonInteractiveArgs(), '--listTests', '--passWithNoTests'],
        projectRoot
      );
      if (!result.passed) throw new Error(result.errors.join('\n'));
      return this.parseListTestsOutput(result.output);
    } catch (e) {
      // CRA should not fall back to direct jest — it will break JSX transforms
      if (this.forceScript) throw e;

      // Fallback: direct jest listTests
      try {
        const result = await this.runJest(['--listTests', '--passWithNoTests'], projectRoot, 'direct');
        if (!result.passed) throw new Error(result.errors.join('\n'));
        return this.parseListTestsOutput(result.output);
      } catch {
        // Last-resort fallback: filesystem scan
        return this.discoverTestsFromFilesystem(projectRoot);
      }
    }
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    this.ensureMode(projectRoot);

    // CRA projects: use scripts to guarantee transforms + correct env
    if (this.forceScript) {
      if (withCoverage && this.hasNpmScript(projectRoot, 'coverage')) {
        // best: use project's coverage script
        return this.runNpmScript(projectRoot, 'coverage');
      }

      // else: npm test -- --watchAll=false ... (safe)
      const args = [
        ...this.baseNonInteractiveArgs(),
        ...(withCoverage
          ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
          : []),
      ];
      return this.runJest(args, projectRoot, 'script');
    }

    // Non-CRA: if there is a test script, run it; else direct jest
    const args = withCoverage
      ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
      : [];
    return this.runJest(args, projectRoot);
  }

  async runTestFile(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();
    // CRA-friendly: run by path, non-interactive
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
  // Mode / config
  // -------------------------

  private ensureMode(projectRoot: string) {
    this.projectRoot = projectRoot;

    const pkg = this.readPackageJson(projectRoot);
    const testScript = (pkg?.scripts?.test ?? '') as string;

    const hasTestScript = typeof testScript === 'string' && testScript.trim().length > 0;

    // CRA detection: react-scripts in scripts OR dependencies
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const hasReactScriptsDep = typeof deps['react-scripts'] === 'string';
    const isCRA =
      (typeof testScript === 'string' && testScript.includes('react-scripts test')) ||
      hasReactScriptsDep;

    this.forceScript = isCRA;

    if (isCRA) {
      this.mode = 'script';
      return;
    }

    // Non-CRA: prefer script if exists, else direct
    this.mode = hasTestScript ? 'script' : 'direct';
  }

  private hasNpmScript(projectRoot: string, name: string): boolean {
    const pkg = this.readPackageJson(projectRoot);
    return Boolean(pkg?.scripts && typeof pkg.scripts[name] === 'string');
  }

  // -------------------------
  // Execution
  // -------------------------

  private baseNonInteractiveArgs(): string[] {
    // Stops CRA/react-scripts prompting "Press a..." etc.
    return ['--watchAll=false'];
  }

  private async runNpmScript(projectRoot: string, scriptName: string): Promise<TestResult> {
    const cmd = this.platformCmd('npm');
    const cmdArgs = ['run', scriptName];
    return this.spawnToResult(cmd, cmdArgs, projectRoot);
  }

  private async runJest(args: string[], cwd: string, overrideMode?: Mode): Promise<TestResult> {
    const mode = overrideMode ?? this.mode;

    if (mode === 'script') {
      const cmd = this.platformCmd('npm');
      const cmdArgs = ['run', 'test', '--', ...args];
      return this.spawnToResult(cmd, cmdArgs, cwd);
    }

    const { cmd, cmdArgs } = this.buildDirectCommand(args);
    return this.spawnToResult(cmd, cmdArgs, cwd);
  }

  private spawnToResult(cmd: string, cmdArgs: string[], cwd: string): Promise<TestResult> {
    // prevent overlapping runs
    this.killProcesses();

    return new Promise((resolve) => {
      const child = spawn(cmd, cmdArgs, {
        cwd,
        shell: false,
        env: {
          ...process.env,
          CI: 'true', // extra safety: keeps CRA non-interactive
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
          errors: passed ? [] : [stderr || `Test failed with code ${code}`],
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

  private parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      // keep only likely paths
      .filter((l) => l.includes('/') || l.includes(path.sep));
  }

  private buildDirectCommand(extraArgs: string[]) {
    const parts = this.splitCommand(this.jestCommand);
    const cmdRaw = parts.shift() || 'npx';
    const cmd = this.platformCmd(cmdRaw);
    return { cmd, cmdArgs: [...parts, ...extraArgs] };
  }

  private platformCmd(bin: string) {
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

      if (!inQuotes && (ch === '"' || ch === "'")) {
        inQuotes = true;
        quote = ch as any;
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
    if (!this.projectRoot) throw new Error('projectRoot not set (call discoverTests(projectRoot) first).');
    return this.projectRoot;
  }
}