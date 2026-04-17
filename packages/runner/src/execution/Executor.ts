import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BinaryResolver } from '../resolution/BinaryResolver';
import { logger } from '../utils/logger';

const FILE = 'Executor.ts';

export interface ExecutionResult {
  passed: boolean;
  stdout: string;
  stderr: string;
}

export interface ExecutorCommand {
  /** Absolute path to the jest binary (or 'npx'). */
  binary: string;
  /** Arguments to pass to the binary. */
  args: string[];
  /** Working directory (project root). */
  cwd: string;
  /** Extra environment variables merged into the child process env. */
  extraEnv?: Record<string, string>;
}

/**
 * Executes Jest as a child process.
 *
 * Key design decisions:
 *  - Uses `--outputFile=<tmpfile>` instead of capturing stdout to avoid Windows
 *    pipe-buffering issues that can truncate large JSON output.
 *  - Streams stderr to the logger in real time so the user sees progress.
 *  - Stdout is still captured as a fallback (CRA occasionally skips --outputFile
 *    on a bailed run and writes JSON to stdout instead).
 *  - A single ChildProcess reference is held so killProcesses() works cleanly.
 */
export class Executor {
  private child?: ChildProcess;
  private logger: (msg: string) => void;
  private readonly tmpDir: string;

  constructor(logger: (msg: string) => void = () => {}, tmpDir?: string) {
    this.logger = logger;
    this.tmpDir = tmpDir ?? os.tmpdir();
  }

  setLogger(logger: (msg: string) => void): void {
    this.logger = logger;
  }

  /**
   * Run Jest with JSON capture.
   *
   * Appends `--outputFile=<tmpfile>` to the args automatically.
   * Returns the raw JSON string (from the output file or stdout fallback)
   * plus the pass/fail status and any stderr.
   */
  async runWithJsonCapture(command: ExecutorCommand): Promise<ExecutionResult & { jsonOutput: string }> {
    if (!fs.existsSync(command.cwd)) {
      logger.error(FILE, 'runWithJsonCapture', `Project root does not exist: "${command.cwd}"`);
      return {
        passed: false,
        stdout: '',
        stderr: `Project root does not exist: ${command.cwd}`,
        jsonOutput: '',
      };
    }

    const tmpFile = path.join(
      this.tmpDir,
      `ltr-jest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );

    const args = [...command.args, `--outputFile=${tmpFile}`];
    const { binary, cmdArgs } = this.buildInvocation(command.binary, args);

    this.logger(`> ${binary} ${cmdArgs.join(' ')}`);
    this.kill();

    const result = await this.spawn(binary, cmdArgs, command.cwd, command.extraEnv);

    // Prefer the output file; fall back to captured stdout for CRA edge cases.
    let jsonOutput = '';
    try {
      if (fs.existsSync(tmpFile)) {
        jsonOutput = fs.readFileSync(tmpFile, 'utf8');
        if (!jsonOutput.trim()) {
          logger.warn(FILE, 'runWithJsonCapture', `Output file exists but is empty — falling back to stdout. tmpFile="${tmpFile}"`);
          jsonOutput = result.stdout;
        }
      } else {
        logger.warn(FILE, 'runWithJsonCapture', `Output file not produced by Jest — falling back to stdout. tmpFile="${tmpFile}"`);
        jsonOutput = result.stdout;
      }
      if (!jsonOutput.trim()) {
        logger.error(FILE, 'runWithJsonCapture', `No JSON output produced (file empty and stdout empty) — binary="${command.binary}" cwd="${command.cwd}"`);
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }

    return { ...result, jsonOutput };
  }

  /**
   * Run Jest and stream per-file results by polling a reporter output file.
   *
   * The caller is responsible for configuring Jest to use liveReporter.js with
   * the given reporterFile as the output path. This method polls that file at
   * 200 ms intervals while Jest runs, calling onRecord for each complete JSON
   * line. A final poll fires after the process exits to catch any trailing records.
   */
  async runWithReporterPolling(
    command: ExecutorCommand,
    reporterFile: string,
    onRecord: (record: unknown) => void,
  ): Promise<ExecutionResult> {
    if (!fs.existsSync(command.cwd)) {
      logger.error(FILE, 'runWithReporterPolling', `Project root does not exist: "${command.cwd}"`);
      return { passed: false, stdout: '', stderr: `Project root does not exist: ${command.cwd}` };
    }

    const { binary, cmdArgs } = this.buildInvocation(command.binary, command.args);
    this.logger(`> ${binary} ${cmdArgs.join(' ')}`);
    this.kill();

    let offset = 0;
    let partial = '';

    const pollReporter = () => {
      if (!fs.existsSync(reporterFile)) { return; }
      try {
        const stat = fs.statSync(reporterFile);
        if (stat.size <= offset) { return; }
        const fd = fs.openSync(reporterFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        const chunk = partial + buf.toString('utf8');
        const lines = chunk.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) { try { onRecord(JSON.parse(trimmed)); } catch {} }
        }
      } catch {}
    };

    const interval = setInterval(pollReporter, 200);
    try {
      return await this.spawn(binary, cmdArgs, command.cwd, command.extraEnv);
    } finally {
      clearInterval(interval);
      pollReporter();
      if (partial.trim()) { try { onRecord(JSON.parse(partial.trim())); } catch {} }
    }
  }

  /**
   * Run Jest without JSON capture (used for discoverTests / listTests).
   */
  async run(command: ExecutorCommand): Promise<ExecutionResult> {
    if (!fs.existsSync(command.cwd)) {
      logger.error(FILE, 'run', `Project root does not exist: "${command.cwd}"`);
      return {
        passed: false,
        stdout: '',
        stderr: `Project root does not exist: ${command.cwd}`,
      };
    }

    const { binary, cmdArgs } = this.buildInvocation(command.binary, command.args);
    this.logger(`> ${binary} ${cmdArgs.join(' ')}`);
    this.kill();

    return this.spawn(binary, cmdArgs, command.cwd, command.extraEnv);
  }

  kill(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = undefined;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Handles the `node <script.js>` case for legacy jest.js binary paths.
   * All other binaries are invoked directly.
   */
  private buildInvocation(binary: string, args: string[]): { binary: string; cmdArgs: string[] } {
    if (BinaryResolver.isNodeScript(binary)) {
      return { binary: process.execPath, cmdArgs: [binary, ...args] };
    }
    // npx needs the jest subcommand first
    if (binary === 'npx' || binary === 'npx.cmd') {
      return { binary, cmdArgs: ['jest', ...args] };
    }
    return { binary, cmdArgs: args };
  }

  private spawn(binary: string, cmdArgs: string[], cwd: string, extraEnv?: Record<string, string>): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);

      const child = spawn(binary, cmdArgs, {
        cwd,
        shell: useShell,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          BABEL_ENV: 'test',
          CI: 'true',
          ...extraEnv,
        },
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
        resolve({ passed: exitCode === 0, stdout, stderr });
      };

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stdout?.on('end', () => { stdoutEnded = true; maybeResolve(); });

      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        this.logger(chunk.trimEnd());
      });
      child.stderr?.on('end', () => { stderrEnded = true; maybeResolve(); });

      child.on('exit', (code) => { exitCode = code ?? 1; maybeResolve(); });

      child.on('error', (err) => {
        if (resolved) return;
        logger.error(FILE, 'spawn', `Child process error — binary="${binary}" cwd="${cwd}"`, err);
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, stdout: '', stderr: err.message });
      });
    });
  }
}
