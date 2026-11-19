/**
 * The MCP relay: a stdio MCP server an agent starts (Claude Code, Codex,
 * Gemini CLI, Cursor…). It holds no state and does no work: it lists the
 * tools and prompts (catalog.ts), and passes each tool call to the editor
 * window through the file mailbox (protocol.ts), then returns the window's
 * answer. All logic stays in the extension.
 *
 * Hand-written MCP (JSON-RPC 2.0, one message per line on stdin / stdout):
 * initialize, ping, tools/list, tools/call, prompts/list, prompts/get. No
 * network module, no SDK. Nothing but protocol messages goes to stdout.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS, PROMPTS, toolByName, promptText } from '../catalog';
import { INSTRUCTIONS } from '../instructions';
import { BridgeInfo, BridgeRequest, BridgeResponse, PROTOCOL_VERSION, isProcessAlive, mailboxDirs, newRequestId, readJson, writeJsonAtomic } from '../protocol';
import { chooseWindow, isOpen, WindowChoice } from './discovery';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RelayOptions {
  /** Writes one JSON-RPC message (a line on stdout). */
  send: (msg: unknown) => void;
  /** The agent's folder: picks the window. */
  workspace: string;
  version: string;
  sessionDir?: string;
  pointerDirs?: string[];
  tmpRoot?: string;
  /** Fatal / debug notes (stderr). */
  log?: (msg: string) => void;
}

export class McpRelay {
  private _client: string | undefined;
  private _window: BridgeInfo | undefined;

  constructor(private readonly _o: RelayOptions) {}

  async handle(msg: RpcMessage): Promise<void> {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && msg.id !== undefined && msg.method === undefined) { return; } // a response to us: we send no requests
      this._error(msg?.id ?? null, -32600, 'Invalid request');
      return;
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this._dispatch(msg.method, msg.params ?? {});
      if (isRequest) { this._o.send({ jsonrpc: '2.0', id: msg.id, result }); }
    } catch (err) {
      if (!isRequest) { return; }
      const e = err as { code?: number; message?: string };
      this._error(msg.id!, typeof e.code === 'number' ? e.code : -32603, e.message ?? String(err));
    }
  }

  private _error(id: string | number | null, code: number, message: string): void {
    this._o.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private async _dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const info = params.clientInfo as { name?: string } | undefined;
        this._client = typeof info?.name === 'string' ? info.name : undefined;
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'live-test-runner', title: 'Live Test Runner', version: this._o.version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping': return {};
      case 'tools/list':
        return {
          tools: TOOLS.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: !t.acts, destructiveHint: false, openWorldHint: false },
          })),
        };
      case 'tools/call': return this._callTool(String(params.name ?? ''), (params.arguments as Record<string, unknown>) ?? {});
      case 'prompts/list':
        return { prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, ...(p.arguments ? { arguments: p.arguments } : {}) })) };
      case 'prompts/get': {
        const p = PROMPTS.find((x) => x.name === params.name);
        if (!p) { throw Object.assign(new Error(`Unknown prompt ${String(params.name)}`), { code: -32602 }); }
        const args = (params.arguments as Record<string, string>) ?? {};
        return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: promptText(p, args) } }] };
      }
      default:
        if (method.startsWith('notifications/')) { return undefined; }
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  private async _callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const def = toolByName(name);
    if (!def) { throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 }); }
    const choice = this._pickWindow();
    if (!choice.chosen) { return this._noWindow(name, choice); }
    const win = choice.chosen;
    const res = await this._ask(win, name, args, def.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let text = res.text;
    if (name === 'LTR_get_status' && !res.isError) {
      // Which window answered, and the others an agent could mean.
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        body.window = { editor: win.editor, folders: win.workspaceRoots };
        if (choice.others.length) { body.otherWindows = choice.others.map((w) => ({ editor: w.editor, folders: w.workspaceRoots })); }
        if (win.protocol !== PROTOCOL_VERSION || win.version !== this._o.version) { body.versionNote = `The editor runs Live Test Runner ${win.version}; this connection uses ${this._o.version}. Restart the agent after updating the extension.`; }
        text = JSON.stringify(body);
      } catch { /* answer as is */ }
    }
    return { content: [{ type: 'text', text }], ...(res.isError ? { isError: true } : {}) };
  }

  /** The window for this call: the last one while it stays open, else chosen again. */
  private _pickWindow(): WindowChoice {
    if (this._window && isOpen(this._window)) {
      const others = this._window ? chooseWindow(this._opts()).others.filter((w) => w.sessionDir !== this._window!.sessionDir) : [];
      return { chosen: this._window, others };
    }
    const choice = chooseWindow(this._opts());
    this._window = choice.chosen;
    return choice;
  }

  private _opts() {
    return { workspace: this._o.workspace, sessionDir: this._o.sessionDir, pointerDirs: this._o.pointerDirs, tmpRoot: this._o.tmpRoot };
  }

  private _noWindow(name: string, choice: WindowChoice): unknown {
    const open = choice.others.map((w) => `${w.editor}: ${w.workspaceRoots.join(', ') || '(no folder)'}`);
    const text = JSON.stringify({
      error: `No VS Code or Cursor window with Live Test Runner has ${this._o.workspace} open.`,
      fix: 'Open this folder in VS Code (or Cursor) with the Live Test Runner extension, then call the tool again.',
      ...(open.length ? { openWindows: open } : {}),
    });
    return { content: [{ type: 'text', text }], ...(name === 'LTR_get_status' ? {} : { isError: true }) };
  }

  /** One request through the mailbox; fails at once if the window closes. */
  private async _ask(win: BridgeInfo, tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<BridgeResponse> {
    const dirs = mailboxDirs(win.sessionDir);
    const id = newRequestId();
    const req: BridgeRequest = { id, tool, args, sentAt: Date.now(), ...(this._client ? { client: this._client } : {}) };
    const answerFile = path.join(dirs.responses, `${id}.json`);
    try {
      writeJsonAtomic(path.join(dirs.requests, `${id}.json`), req);
    } catch (err) {
      return { id, isError: true, text: JSON.stringify({ error: `Could not reach the editor window (${(err as Error).message}). If the agent runs in a sandbox, allow it to write to ${win.sessionDir}.` }) };
    }
    const deadline = Date.now() + timeoutMs;
    let nextAliveCheck = Date.now() + 1000;
    for (;;) {
      const res = readJson<BridgeResponse>(answerFile);
      if (res && res.id === id) {
        try { fs.rmSync(answerFile, { force: true }); } catch { /* the folder is cleaned with the window */ }
        return res;
      }
      const now = Date.now();
      if (now >= nextAliveCheck) {
        nextAliveCheck = now + 1000;
        if (!isProcessAlive(win.pid)) {
          this._window = undefined;
          return { id, isError: true, text: JSON.stringify({ error: 'The editor window closed before it answered. Open the folder again and retry.' }) };
        }
      }
      if (now >= deadline) {
        try { fs.rmSync(path.join(dirs.requests, `${id}.json`), { force: true }); } catch { /* picked up meanwhile */ }
        return { id, isError: true, text: JSON.stringify({ error: `The editor did not answer within ${Math.round(timeoutMs / 1000)} s (it may be busy). Try again; for runs, use LTR_get_status.` }) };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

/** Reads JSON-RPC lines from stdin, answers on stdout (the relay's process entry). */
export function runStdio(version: string): void {
  const out = (msg: unknown) => { process.stdout.write(`${JSON.stringify(msg)}\n`); };
  const argWs = (() => { const i = process.argv.indexOf('--workspace'); return i > 0 ? process.argv[i + 1] : undefined; })();
  const relay = new McpRelay({
    send: out,
    workspace: path.resolve(argWs || process.env.LTR_WORKSPACE || process.cwd()),
    version,
    sessionDir: process.env.LTR_SESSION_DIR || undefined,
    pointerDirs: process.env.LTR_POINTER_DIR ? [process.env.LTR_POINTER_DIR] : [],
  });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) { continue; }
      let msg: RpcMessage;
      try { msg = JSON.parse(line) as RpcMessage; } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (Array.isArray(msg)) { for (const m of msg) { void relay.handle(m as RpcMessage); } continue; }
      void relay.handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
