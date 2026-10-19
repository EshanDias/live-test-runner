import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BinaryResolver, nodeRuntime } from '../resolution/BinaryResolver';
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
  /** Jest's JS entry point, a binary path, or a command name such as 'npx' / 'npm'. */
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
 *  - Jest's JS entry point runs with `node` and no shell, so arguments (paths
 *    with spaces, `^…$` name patterns, `a|b`) reach Jest exactly as given.
 *    A shell is used only for commands that need one (user `jestCommand`,
 *    npx, .cmd shims), with every argument quoted.
 *  - kill() ends the whole process tree — on Windows killing only the direct
 *    child left Jest (or a shell's grandchild) running.
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
    const inv = this.buildInvocation(command.binary, args);

    this.kill();

    const result = await this.spawn(inv, command.cwd, command.extraEnv);

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

    const inv = this.buildInvocation(command.binary, command.args);
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
      return await this.spawn(inv, command.cwd, command.extraEnv, true);
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

    const inv = this.buildInvocation(command.binary, command.args);
    this.kill();

    return this.spawn(inv, command.cwd, command.extraEnv);
  }

  /** Ends the running Jest process and everything it started (workers, shells). */
  kill(): void {
    const child = this.child;
    this.child = undefined;
    if (!child || child.pid === undefined || child.exitCode !== null) { return; }
    killTree(child);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Decides how to start `binary`:
   *  - a .js entry point → `node <entry> …args`, no shell
   *  - npx / npm / yarn / a .cmd shim on Windows → through the shell, args quoted
   *  - anything else → executed directly
   */
  private buildInvocation(binary: string, args: string[]): Invocation {
    if (BinaryResolver.isNodeScript(binary)) {
      const node = nodeRuntime();
      return { file: node.binary, args: [binary, ...args], shell: false, env: node.env };
    }
    // npx needs the jest subcommand first
    const cmdArgs = /^npx(\.cmd)?$/i.test(binary) ? ['jest', ...args] : args;
    const needsShell = process.platform === 'win32'
      ? /\.(cmd|bat)$/i.test(binary) || !path.isAbsolute(binary)
      : false;
    return { file: binary, args: cmdArgs, shell: needsShell, env: {} };
  }

  private spawn(
    inv: Invocation,
    cwd: string,
    extraEnv?: Record<string, string>,
    forwardStdout = false,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const tag = `jest#${++Executor._seq}`;
      const startedAt = Date.now();
      const binary = inv.file;

      const raw = (line: string) => this.logger(line ? `[${tag}] ${stripAnsi(line)}` : '');
      raw(`> ${[inv.file, ...inv.args].map(displayArg).join(' ')}`);
      log.debug(`${tag} started: ${path.basename(binary)} (${inv.args.length} args, cwd ${cwd})`);

      const env = {
        ...process.env,
        NODE_ENV: 'test',
        BABEL_ENV: 'test',
        CI: 'true',
        ...inv.env,
        ...extraEnv,
      };
      // With a shell, Node would join the args unquoted (DEP0190), so build the
      // command line ourselves with every argument quoted for that shell.
      const child = inv.shell
        ? spawn([inv.file, ...inv.args].map(shellQuote).join(' '), { cwd, env, shell: true, windowsHide: true, detached: !IS_WIN })
        : spawn(inv.file, inv.args, { cwd, env, windowsHide: true, detached: !IS_WIN });

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

const IS_WIN = process.platform === 'win32';

interface Invocation {
  file: string;
  args: string[];
  shell: boolean;
  env: Record<string, string>;
}

/** Quote one argument for the platform shell (cmd.exe on Windows, sh elsewhere). */
function shellQuote(arg: string): string {
  if (/^[\w\-.:\\/=@+,]+$/.test(arg)) { return arg; }
  if (IS_WIN) {
    // MSVCRT rules: backslashes are literal unless they precede a quote.
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Argument as shown in the "> command" line of the Jest Output channel. */
function displayArg(arg: string): string {
  return /[\s"|&^<>]/.test(arg) ? JSON.stringify(arg) : arg;
}

/**
 * Kill a child and its descendants. Windows has no process groups, so the
 * tree is ended with taskkill /T. Elsewhere the child leads its own process
 * group (spawned detached), so signalling -pid reaches every descendant.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid as number;
  if (IS_WIN) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const r = spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      if (r.status === 0) { return; }
      log.debug(`taskkill exited ${r.status} for pid ${pid} — falling back to child.kill()`);
    } catch (err) {
      log.debug(`taskkill failed for pid ${pid}: ${(err as Error).message}`);
    }
    try { child.kill(); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const force = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  }, 3000);
  force.unref?.();
  child.once('exit', () => clearTimeout(force));
}

/** Last `n` non-empty lines of a text block, ANSI-stripped — for error context. */
export function tail(text: string, n = 25): string {
  const lines = stripAnsi(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).map((l) => '    ' + l).join('\n') || '    (no output)';
}
