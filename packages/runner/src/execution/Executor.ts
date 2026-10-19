import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BinaryResolver } from '../resolution/BinaryResolver';
import { createLogger, LogLevel, stripAnsi } from '../utils/logger';

const log = createLogger('Executor');
const childLog = createLogger('Jest');

/**
 * Lines written by our instrumentation inside the Jest process use the form
 * `[LTR:<level>] message`. They are routed to the structured log at that level
 * instead of the raw Jest output, and are excluded from captured stderr.
 */
const CHILD_LOG_RE = /^\[LTR:(trace|debug|info|warn|error)\] ?(.*)$/;

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
 * Splits a stream of text chunks into complete lines. Chunks from a child
 * process can end mid-line (or, without setEncoding, mid-character), so lines
 * are only emitted once their newline has arrived.
 */
class LineSplitter {
  private _buf = '';
  constructor(private readonly _onLine: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this._buf + chunk).split('\n');
    this._buf = parts.pop() ?? '';
    for (const p of parts) { this._onLine(p.endsWith('\r') ? p.slice(0, -1) : p); }
  }

  flush(): void {
    if (!this._buf) { return; }
    const rest = this._buf.endsWith('\r') ? this._buf.slice(0, -1) : this._buf;
    this._buf = '';
    this._onLine(rest);
  }
}

/**
 * Executes Jest as a child process.
 *
 * Key design decisions:
 *  - Uses `--outputFile=<tmpfile>` instead of capturing stdout to avoid Windows
 *    pipe-buffering issues that can truncate large JSON output.
 *  - Streams stderr to the output sink line by line, ANSI-stripped and tagged
 *    with a per-process id (`[jest#12]`) so concurrent runs can be told apart.
 *  - Stdout is still captured as a fallback (CRA occasionally skips --outputFile
 *    on a bailed run and writes JSON to stdout instead).
 *  - A single ChildProcess reference is held so kill() works cleanly.
 */
export class Executor {
  private static _seq = 0;

  private child?: ChildProcess;
  private logger: (msg: string) => void;
  private readonly tmpDir: string;

  /** @param logger Sink for raw Jest output lines (the "Jest Output" channel). */
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
      log.error(`Project root does not exist: ${command.cwd}`);
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

    this.kill();

    const result = await this.spawn(binary, cmdArgs, command.cwd, command.extraEnv);

    // Prefer the output file; fall back to captured stdout for CRA edge cases.
    let jsonOutput = '';
    try {
      if (fs.existsSync(tmpFile)) {
        jsonOutput = fs.readFileSync(tmpFile, 'utf8');
        if (!jsonOutput.trim()) {
          log.debug('Jest wrote an empty --outputFile — using stdout instead');
          jsonOutput = result.stdout;
        }
      } else {
        log.debug('Jest did not write --outputFile — using stdout instead');
        jsonOutput = result.stdout;
      }
      if (!jsonOutput.trim()) {
        log.error(
          `Jest produced no JSON result (cwd: ${command.cwd}). Last stderr lines:\n${tail(result.stderr)}`,
        );
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
      log.error(`Project root does not exist: ${command.cwd}`);
      return { passed: false, stdout: '', stderr: `Project root does not exist: ${command.cwd}` };
    }

    const { binary, cmdArgs } = this.buildInvocation(command.binary, command.args);
    this.kill();

    let offset = 0;
    let partial = '';
    let badRecords = 0;

    const parseRecord = (text: string) => {
      try { onRecord(JSON.parse(text)); } catch { badRecords++; }
    };

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
          if (trimmed) { parseRecord(trimmed); }
        }
      } catch (err) {
        log.debug(`Reporter poll failed (will retry): ${(err as Error).message}`);
      }
    };

    const interval = setInterval(pollReporter, 200);
    try {
      // Stdout is forwarded here: test console output written directly by the
      // test (or by a verbose reporter) would otherwise be invisible.
      return await this.spawn(binary, cmdArgs, command.cwd, command.extraEnv, true);
    } finally {
      clearInterval(interval);
      pollReporter();
      if (partial.trim()) { parseRecord(partial.trim()); }
      if (badRecords > 0) {
        log.warn(`${badRecords} reporter record(s) could not be parsed and were skipped`);
      }
    }
  }

  /**
   * Run Jest without JSON capture (used for discoverTests / listTests).
   */
  async run(command: ExecutorCommand): Promise<ExecutionResult> {
    if (!fs.existsSync(command.cwd)) {
      log.error(`Project root does not exist: ${command.cwd}`);
      return {
        passed: false,
        stdout: '',
        stderr: `Project root does not exist: ${command.cwd}`,
      };
    }

    const { binary, cmdArgs } = this.buildInvocation(command.binary, command.args);
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

  private spawn(
    binary: string,
    cmdArgs: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
    forwardStdout = false,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const tag = `jest#${++Executor._seq}`;
      const startedAt = Date.now();
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);

      const raw = (line: string) => this.logger(line ? `[${tag}] ${stripAnsi(line)}` : '');
      raw(`> ${binary} ${cmdArgs.join(' ')}`);
      log.debug(`${tag} started: ${path.basename(binary)} (${cmdArgs.length} args, cwd ${cwd})`);

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

      // setEncoding uses a StringDecoder, so multi-byte UTF-8 characters
      // (✓ ✕ ● › …) split across chunk boundaries decode correctly instead
      // of turning into U+FFFD replacement symbols.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let stdoutEnded = !child.stdout;
      let stderrEnded = !child.stderr;
      let resolved = false;

      const outLines = forwardStdout ? new LineSplitter(raw) : undefined;
      const errLines = new LineSplitter((line) => {
        const m = CHILD_LOG_RE.exec(line);
        if (m) {
          childLog[m[1] as LogLevel](`${tag}: ${m[2]}`);
          return;
        }
        stderr += line + '\n';
        raw(line);
      });

      const maybeResolve = () => {
        if (resolved || exitCode === null || !stdoutEnded || !stderrEnded) return;
        resolved = true;
        this.child = undefined;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log.debug(`${tag} exited (${exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`}) after ${secs}s`);
        resolve({ passed: exitCode === 0, stdout, stderr });
      };

      child.stdout?.on('data', (d: string) => { stdout += d; outLines?.push(d); });
      child.stdout?.on('end', () => { outLines?.flush(); stdoutEnded = true; maybeResolve(); });

      child.stderr?.on('data', (d: string) => errLines.push(d));
      child.stderr?.on('end', () => { errLines.flush(); stderrEnded = true; maybeResolve(); });

      child.on('exit', (code, signal) => { exitCode = code ?? 1; exitSignal = signal; maybeResolve(); });

      child.on('error', (err) => {
        if (resolved) return;
        const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? ' — the Jest binary was not found. Run npm install, or set liveTestRunner.jestCommand.'
          : '';
        log.error(`${tag} could not start "${binary}" (cwd ${cwd})${hint}`, err);
        resolved = true;
        this.child = undefined;
        resolve({ passed: false, stdout: '', stderr: err.message });
      });
    });
  }
}

/** Last `n` non-empty lines of a text block, ANSI-stripped — for error context. */
export function tail(text: string, n = 25): string {
  const lines = stripAnsi(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).map((l) => '    ' + l).join('\n') || '    (no output)';
}
