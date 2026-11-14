/**
 * The window's side of the file mailbox (see protocol.ts): writes
 * `bridge.json`, watches the requests folder, hands each request to the
 * tool handlers and writes the answer. Nothing is built ahead of time: an
 * answer is made when a request arrives (rule 6).
 *
 * `fs.watch` wakes it at once; a slow poll covers file systems where watching
 * is unreliable (network drives, some containers). No VS Code import, so it
 * is unit-tested directly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BRIDGE_FILE, BridgeInfo, BridgeRequest, BridgeResponse, REQUEST_MAX_AGE_MS, isRequestFile, mailboxDirs, readJson, writeJsonAtomic } from './protocol';

export type RequestHandler = (req: BridgeRequest) => Promise<{ text: string; isError?: boolean }>;

export interface MailboxLog {
  debug(msg: string): void;
  warn(msg: string, err?: unknown): void;
}

const POLL_MS = 1500;

export class MailboxServer {
  private readonly _dirs: { requests: string; responses: string };
  private _watcher: fs.FSWatcher | undefined;
  private _poll: ReturnType<typeof setInterval> | undefined;
  private readonly _taken = new Set<string>();
  private _scanQueued = false;
  private _disposed = false;

  constructor(
    private readonly _sessionDir: string,
    private readonly _info: BridgeInfo,
    private readonly _handle: RequestHandler,
    private readonly _log: MailboxLog,
    private readonly _pollMs = POLL_MS,
  ) {
    this._dirs = mailboxDirs(_sessionDir);
  }

  /** Announces the window (bridge.json) and starts answering. */
  start(): void {
    // Only this user may ask or read answers (the temp folder may be shared between users).
    fs.mkdirSync(this._dirs.requests, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this._dirs.responses, { recursive: true, mode: 0o700 });
    for (const dir of [path.dirname(this._dirs.requests), this._dirs.requests, this._dirs.responses]) {
      try { fs.chmodSync(dir, 0o700); } catch { /* Windows: per-user temp folder */ }
    }
    writeJsonAtomic(path.join(this._sessionDir, BRIDGE_FILE), this._info);
    try {
      this._watcher = fs.watch(this._dirs.requests, () => this._queueScan());
      this._watcher.on('error', (err) => { this._log.debug(`AI bridge: folder watch stopped (${(err as Error).message}) — polling only`); this._watcher?.close(); this._watcher = undefined; });
    } catch (err) {
      this._log.debug(`AI bridge: cannot watch the mailbox folder (${(err as Error).message}) — polling only`);
    }
    this._poll = setInterval(() => this._queueScan(), this._pollMs);
    this._poll.unref?.();
    this._queueScan();
  }

  /** Stops answering and withdraws bridge.json (relays then stop picking this window). */
  dispose(): void {
    this._disposed = true;
    this._watcher?.close();
    if (this._poll) { clearInterval(this._poll); }
    try { fs.rmSync(path.join(this._sessionDir, BRIDGE_FILE), { force: true }); } catch { /* the folder goes with the window */ }
  }

  private _queueScan(): void {
    if (this._scanQueued || this._disposed) { return; }
    this._scanQueued = true;
    setImmediate(() => { this._scanQueued = false; this._scan(); });
  }

  private _scan(): void {
    let names: string[];
    try { names = fs.readdirSync(this._dirs.requests); } catch { return; }
    for (const name of names) {
      if (!isRequestFile(name) || this._taken.has(name)) { continue; }
      const file = path.join(this._dirs.requests, name);
      const req = readJson<BridgeRequest>(file);
      if (!req) { continue; } // still being renamed in: next scan
      this._taken.add(name);
      try { fs.rmSync(file, { force: true }); } catch { /* answered anyway */ }
      if (typeof req.id !== 'string' || `${req.id}.json` !== name || typeof req.tool !== 'string') { this._taken.delete(name); continue; }
      if (Date.now() - (req.sentAt ?? 0) > REQUEST_MAX_AGE_MS) {
        this._log.debug(`AI bridge: dropped a stale request (${req.tool})`);
        this._taken.delete(name);
        continue;
      }
      void this._answer(name, req);
    }
  }

  private async _answer(name: string, req: BridgeRequest): Promise<void> {
    let res: BridgeResponse;
    try {
      const out = await this._handle({ ...req, args: req.args && typeof req.args === 'object' ? req.args : {} });
      res = { id: req.id, text: out.text, ...(out.isError ? { isError: true } : {}) };
    } catch (err) {
      this._log.warn(`AI bridge: ${req.tool} failed`, err);
      res = { id: req.id, text: JSON.stringify({ error: `Live Test Runner could not answer ${req.tool}: ${(err as Error).message}` }), isError: true };
    } finally {
      this._taken.delete(name);
    }
    if (this._disposed) { return; }
    try { writeJsonAtomic(path.join(this._dirs.responses, `${req.id}.json`), res); } catch (err) { this._log.warn('AI bridge: could not write an answer', err); }
  }
}
