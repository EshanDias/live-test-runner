import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';
import * as fs from 'fs';
import * as path from 'path';

type ExecMode = 'script' | 'direct';

export class JestRunner implements TestRunner {
  private jestCommand: string;
  private mode: ExecMode = 'direct';
  private projectRoot?: string;
  private child?: ChildProcessWithoutNullStreams;

  constructor(jestCommand: string = 'npx jest') {
    this.jestCommand = jestCommand;
  }

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.projectRoot = projectRoot;

    const pkg = this.readPackageJson(projectRoot);
    const testScript = pkg?.scripts?.test as string | undefined;

    // If there's a test script, prefer it (CRA/react-scripts etc),
    // BUT still use --listTests (source of truth).
    if (testScript) {
      this.mode = 'script';
      try {
        return await this.discoverTestsViaScript(projectRoot);
      } catch {
        // fall through to direct jest
      }
    }

    this.mode = 'direct';
    try {
      return await this.discoverTestsWithJest(projectRoot);
    } catch {
      // last resort fallback (not ideal, but better than nothing)
      return this.discoverTestsFromFilesystem(projectRoot);
    }
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    this.projectRoot = projectRoot;

    const base = this.baseNonInteractiveArgs();
    const cov = withCoverage
      ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
      : [];

    return this.runJest([...base, ...cov], projectRoot);
  }

  async runTestFile(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();

    // Use --runTestsByPath for CRA reliability
    const args = [...this.baseNonInteractiveArgs(), '--runTestsByPath', filePath];
    return this.runJest(args, cwd);
  }

  async runTestFiles(files: string[]): Promise<TestResult> {
    const cwd = this.requireProjectRoot();

    // Run multiple files reliably
    const args = [...this.baseNonInteractiveArgs(), '--runTestsByPath', ...files];
    return this.runJest(args, cwd);
  }

  async runRelatedTests(filePath: string): Promise<TestResult> {
    const cwd = this.requireProjectRoot();

    const args = [...this.baseNonInteractiveArgs(), '--findRelatedTests', filePath];
    return this.runJest(args, cwd);
  }

  isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.');
  }

  async getCoverage(): Promise<any> {
    const cwd = this.requireProjectRoot();

    // Jest writes this when using --coverageReporters=json
    const coveragePath = path.join(cwd, 'coverage', 'coverage-final.json');
    if (fs.existsSync(coveragePath)) {
      return JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    }
    return {};
  }

  killProcesses(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.child = undefined;
  }

  // ------------------------
  // Internals
  // ------------------------

  private async discoverTestsViaScript(projectRoot: string): Promise<string[]> {
    // CRA: ensure non-interactive so it doesn't prompt ("Press a...")
    const args = [...this.baseNonInteractiveArgs(), '--listTests', '--passWithNoTests'];
    const result = await this.runJest(args, projectRoot);
    if (!result.passed) throw new Error('listTests via script failed');
    return this.parseListTestsOutput(result.output);
  }

  private async discoverTestsWithJest(projectRoot: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const { cmd, cmdArgs } = this.buildDirectCommand(['--listTests', '--passWithNoTests']);

      const child = this.spawnTracked(cmd, cmdArgs, projectRoot);

      let output = '';
      let err = '';

      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));

      child.on('close', (code) => {
        this.child = undefined;
        if (code === 0) resolve(this.parseListTestsOutput(output));
        else reject(new Error(err || `Jest --listTests failed (${code})`));
      });

      child.on('error', (e) => {
        this.child = undefined;
        reject(e);
      });
    });
  }

  private discoverTestsFromFilesystem(projectRoot: string): string[] {
    const testFiles: string[] = [];

    const scanDir = (dir: string) => {
      let items: string[] = [];
      try {
        items = fs.readdirSync(path.join(projectRoot, dir));
      } catch {
        return;
      }

      for (const item of items) {
        const rel = path.join(dir, item);
        const abs = path.join(projectRoot, rel);

        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          if (
            item.startsWith('.') ||
            item === 'node_modules' ||
            item === 'build' ||
            item === 'dist' ||
            item === 'out' ||
            item === 'coverage'
          ) {
            continue;
          }
          scanDir(rel);
        } else if (stat.isFile()) {
          if (item.includes('.test.') || item.includes('.spec.')) {
            testFiles.push(abs);
          }
        }
      }
    };

    scanDir('');
    return testFiles;
  }

  private async runJest(args: string[], cwd?: string): Promise<TestResult> {
    const runCwd = cwd ?? this.requireProjectRoot();

    return new Promise((resolve) => {
      let cmd: string;
      let cmdArgs: string[];

      if (this.mode === 'script') {
        // npm run test -- <args>
        cmd = this.platformCmd('npm');
        cmdArgs = ['run', 'test', '--', ...args];
      } else {
        const built = this.buildDirectCommand(args);
        cmd = built.cmd;
        cmdArgs = built.cmdArgs;
      }

      const child = this.spawnTracked(cmd, cmdArgs, runCwd);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('close', (code) => {
        this.child = undefined;
        const passed = code === 0;
        const output = stdout + stderr;
        const errors = passed ? [] : [stderr || `Test failed with code ${code}`];

        resolve({ passed, output, errors });
      });

      child.on('error', (err) => {
        this.child = undefined;
        resolve({ passed: false, output: '', errors: [err.message] });
      });
    });
  }

  private spawnTracked(cmd: string, cmdArgs: string[], cwd: string) {
    // kill any previous run before starting a new one
    this.killProcesses();

    const child = spawn(cmd, cmdArgs, {
      cwd,
      shell: false, // IMPORTANT: avoid PowerShell .ps1 shims + quoting hell
      env: {
        ...process.env,
        CI: 'true', // makes CRA/jest non-interactive
      },
    });

    this.child = child;
    return child;
  }

  private baseNonInteractiveArgs(): string[] {
    // prevents CRA/react-scripts prompting; safe for normal Jest too
    return ['--watchAll=false'];
  }

  private parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      // some runners echo extra lines; keep only paths that look like files
      .filter((l) => l.includes(path.sep) || l.includes('/'));
  }

  private buildDirectCommand(extraArgs: string[]) {
    const parts = this.splitCommand(this.jestCommand);
    const cmdRaw = parts.shift() || 'npx';
    const cmd = this.platformCmd(cmdRaw);
    const cmdArgs = [...parts, ...extraArgs];
    return { cmd, cmdArgs };
  }

  private platformCmd(bin: string) {
    // Avoid PowerShell script execution policy issues on Windows.
    if (process.platform === 'win32') {
      if (!bin.toLowerCase().endsWith('.cmd') && !bin.toLowerCase().endsWith('.exe')) {
        return `${bin}.cmd`;
      }
    }
    return bin;
  }

  private splitCommand(command: string): string[] {
    // Splits by spaces but preserves quoted substrings.
    // Example: 'node "C:\\path with spaces\\jest.js"' => [node, C:\path with spaces\jest.js]
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    let quoteChar: '"' | "'" | null = null;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];

      if ((ch === '"' || ch === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = ch as any;
        continue;
      }

      if (inQuotes && ch === quoteChar) {
        inQuotes = false;
        quoteChar = null;
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

  private requireProjectRoot(): string {
    if (!this.projectRoot) throw new Error('projectRoot not set. Call discoverTests(projectRoot) first.');
    return this.projectRoot;
  }
}