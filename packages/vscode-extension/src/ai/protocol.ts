/**
 * The file mailbox between the MCP relay (a process the agent starts) and
 * the extension (inside the editor window). No sockets, no ports: requests
 * and answers are small JSON files in the window's session folder.
 *
 *   <sessionDir>/bridge.json                  who this window is (BridgeInfo)
 *   <sessionDir>/bridge/requests/<id>.json    the relay asks   (BridgeRequest)
 *   <sessionDir>/bridge/responses/<id>.json   the window answers (BridgeResponse)
 *
 * Files are written to a temp name and renamed, so a reader never sees half
 * a file. The relay deletes the answer it read; the window drops requests
 * older than {@link REQUEST_MAX_AGE_MS}. The session folder (and so the
 * mailbox) is removed when the window closes.
 *
 * No VS Code import: the relay bundles this file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** Bumped when the files change shape; a relay and window of different versions say so. */
export const PROTOCOL_VERSION = 1;

export const BRIDGE_FILE = 'bridge.json';
export const MAILBOX_DIR = 'bridge';

/** A request no window picked up for this long is stale (the relay gave up long before). */
export const REQUEST_MAX_AGE_MS = 15 * 60_000;

/** Same as the runner's LTR_BASE_TMP_DIR (kept here so the relay bundles no runner code). */
export const BASE_TMP_DIR = path.join(os.tmpdir(), 'com.eshLabs', 'live-test-runner');

/** Who a window is: written once at activation, read by relays to pick the window. */
export interface BridgeInfo {
  protocol: number;
  /** Extension version. */
  version: string;
  /** The extension host's pid (alive = the window is open). */
  pid: number;
  /** When the window's extension started (with the pid: guards against pid reuse). */
  startedAt: number;
  /** The window's workspace folders. */
  workspaceRoots: string[];
  sessionDir: string;
  /** "Visual Studio Code", "Cursor", … */
  editor: string;
}

export interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  sentAt: number;
  /** The agent's name from MCP initialize ("claude-code"), for the log line. */
  client?: string;
}

export interface BridgeResponse {
  id: string;
  /** The tool's answer (JSON text). */
  text: string;
  isError?: boolean;
}

export function mailboxDirs(sessionDir: string): { requests: string; responses: string } {
  const base = path.join(sessionDir, MAILBOX_DIR);
  return { requests: path.join(base, 'requests'), responses: path.join(base, 'responses') };
}

/**
 * Writes JSON so readers never see a partial file (temp file + rename).
 * Readable by the user only: on Linux the temp folder is shared between users.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Parsed JSON, or undefined (missing, partial or not JSON). */
export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

export function newRequestId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

/** A request id is only ever ours: no path tricks in names read from the folder. */
export function isRequestFile(name: string): boolean {
  return /^[a-z0-9]+-[a-f0-9]{12}\.json$/.test(name);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
