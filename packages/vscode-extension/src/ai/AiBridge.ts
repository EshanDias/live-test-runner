/**
 * AiBridge — lets the user's AI assistant read live results and run tests.
 *
 * Two ways in over one set of handlers (tools.ts):
 *  - VS Code language-model tools (Copilot, VS Code ≥ 1.95): registered here,
 *    answered in-process; declared in package.json (`languageModelTools`).
 *  - The MCP relay (out/mcp.js) for Cursor and terminal agents: it reaches
 *    this window through a file mailbox in the session folder (mailbox.ts).
 *    Cursor gets it registered automatically; terminal agents through the
 *    launcher in the extension's storage folder (launcher.ts).
 *
 * The extension never calls an AI service or opens a port (rule 11): the
 * assistant asks, the extension answers with what it already has. An
 * observer (Partial<IResultObserver>) for the run results; everything else is
 * read on request. `liveTestRunner.ai.bridge` turns it all off.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ProjectRegistry } from '../project/ProjectRegistry';
import type { ProjectContext } from '../project/ProjectContext';
import { IResultObserver } from '../IResultObserver';
import { logger } from '../utils/logger';
import { failuresOf } from '../views/ResultsView';
import { failuresForAI } from '../views/copyText';
import { AiTools } from './tools';
import { BridgeHost, BridgeProject, BridgeFramework, AllowRuns } from './host';
import { TOOLS } from './catalog';
import { MailboxServer } from './mailbox';
import { BridgeInfo, PROTOCOL_VERSION } from './protocol';
import { installLauncher, launcherPaths, removeWindowPointer } from './launcher';

const log = logger.scope('AI');

/** The few VS Code APIs newer than our 1.82 floor, feature-detected (see docs/development/design/ai-assistants.md). */
interface LmApi {
  registerTool?(name: string, tool: {
    invoke(options: { input: unknown }, token: vscode.CancellationToken): Promise<unknown>;
    prepareInvocation?(options: { input: unknown }): { invocationMessage?: string } | undefined;
  }): vscode.Disposable;
}
interface CursorMcpApi {
  registerServer?(config: { name: string; server: { command: string; args: string[]; env: Record<string, string> } }): void;
  unregisterServer?(name: string): void;
}

export interface AiBridgeDeps {
  context: vscode.ExtensionContext;
  projects: ProjectRegistry;
  sessionDir: string;
  extensionVersion: string;
  /** The Copy diagnostic report text. */
  diagnostics: () => string;
  /** Framework name and root of a test file (Copy for AI wording). */
  frameworkOf: (testFile: string) => { framework: string; root: string } | undefined;
}

const CURSOR_SERVER = 'live-test-runner';

export class AiBridge implements Partial<IResultObserver>, vscode.Disposable {
  readonly tools: AiTools;
  private _mailbox: MailboxServer | undefined;
  private _lmTools: vscode.Disposable[] = [];
  private _cursorRegistered = false;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _bridgeAdapters = new WeakMap<ProjectContext, BridgeProject>();
  readonly info: BridgeInfo;

  constructor(private readonly _d: AiBridgeDeps) {
    this.tools = new AiTools(this._host());
    this.info = {
      protocol: PROTOCOL_VERSION,
      version: _d.extensionVersion,
      pid: process.pid,
      startedAt: Date.now(),
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      sessionDir: _d.sessionDir,
      editor: vscode.env.appName,
    };
    this._disposables.push(
      vscode.commands.registerCommand('liveTestRunner.fixWithAI', (fileId?: string, nodeId?: string) => this.fixWithAI(fileId, nodeId)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('liveTestRunner.ai.bridge')) { this._apply(); }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.info.workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        if (this._mailbox) { this._stopMailbox(); this._startMailbox(); }
      }),
    );
    this._apply();
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('ai.bridge', true);
  }

  /** The relay's path in this install (out/mcp.js). */
  get serverPath(): string {
    return path.join(this._d.context.extensionPath, 'out', 'mcp.js');
  }

  /** Where the stable launcher lives (the setup commands name it). */
  get launcherPath(): string {
    return launcherPaths(this._d.context.globalStorageUri.fsPath).launcher;
  }

  /** How assistants reach this editor: 'copilot' (LM tools), 'cursor' (MCP registered), or neither. */
  get builtIn(): 'copilot' | 'cursor' | undefined {
    if (this._cursorRegistered) { return 'cursor'; }
    return this._lmTools.length > 0 ? 'copilot' : undefined;
  }

  // ── Observer: what changed and what ran ────────────────────────────────────

  onFileResult(filePath: string): void { this.tools.noteFileResult(filePath); }
  onSessionStopped(): void { this.tools.stopped(); }
  onSessionStarted(): void { this.tools.sessionStarted(); }

  /** Saves and changes on disk (from extension.ts, the session's own events). */
  noteChanged(files: string[]): void { this.tools.noteChanged(files); }

  // ── On / off ──────────────────────────────────────────────────────────────

  private _apply(): void {
    if (this.enabled) {
      this._startMailbox();
      this._registerBuiltIn();
    } else {
      this._stopMailbox();
      this._unregisterBuiltIn();
      log.debug('AI assistant bridge is off (liveTestRunner.ai.bridge)');
    }
  }

  private _startMailbox(): void {
    if (this._mailbox) { return; }
    try {
      const globalDir = this._d.context.globalStorageUri.fsPath;
      installLauncher(globalDir, this.serverPath, this._d.extensionVersion, this.info);
      this._mailbox = new MailboxServer(this._d.sessionDir, this.info, async (req) => {
        const def = TOOLS.find((t) => t.name === req.tool);
        const who = req.client ? ` (${req.client})` : '';
        if (def?.acts) { log.info(`AI assistant${who}: ${req.tool}`); } else { log.debug(`AI assistant${who}: ${req.tool}`); }
        return this.tools.call(req.tool, req.args);
      }, log);
      this._mailbox.start();
      log.debug(`AI assistant bridge ready (MCP launcher: ${this.launcherPath})`);
    } catch (err) {
      log.warn('AI assistant bridge could not start — agents outside the editor cannot connect', err);
      this._mailbox = undefined;
    }
  }

  private _stopMailbox(): void {
    this._mailbox?.dispose();
    this._mailbox = undefined;
    removeWindowPointer(this._d.context.globalStorageUri.fsPath, this._d.sessionDir);
  }

  /** Copilot (LM tools) in VS Code, or the MCP server in Cursor — never both (no duplicate tools). */
  private _registerBuiltIn(): void {
    const v = vscode as unknown as { lm?: LmApi; cursor?: { mcp?: CursorMcpApi } };
    const cursor = v.cursor?.mcp;
    if (cursor?.registerServer) {
      if (this._cursorRegistered) { return; }
      try {
        cursor.registerServer({
          name: CURSOR_SERVER,
          server: {
            // The editor's own runtime as Node: no Node install needed.
            command: process.execPath,
            args: [this.serverPath],
            env: { ELECTRON_RUN_AS_NODE: '1', LTR_SESSION_DIR: this._d.sessionDir },
          },
        });
        this._cursorRegistered = true;
        log.debug('AI assistant bridge registered with Cursor (MCP)');
      } catch (err) {
        log.warn('Could not register the MCP server with Cursor — add it by hand (Connect your AI assistant)', err);
      }
      return;
    }
    if (!v.lm?.registerTool || this._lmTools.length > 0) { return; }
    for (const def of TOOLS) {
      try {
        this._lmTools.push(v.lm.registerTool(def.name, {
          invoke: async (options) => {
            if (def.acts) { log.info(`AI assistant (chat): ${def.name}`); } else { log.debug(`AI assistant (chat): ${def.name}`); }
            const res = await this.tools.call(def.name, (options.input ?? {}) as Record<string, unknown>);
            return lmResult(res.isError ? `Error: ${res.text}` : res.text);
          },
          prepareInvocation: () => ({ invocationMessage: `Live Test Runner: ${def.title.toLowerCase()}` }),
        }));
      } catch (err) {
        log.debug(`Could not register the chat tool ${def.name}: ${(err as Error).message}`);
      }
    }
    if (this._lmTools.length) { log.debug(`AI assistant bridge: ${this._lmTools.length} chat tools registered`); }
  }

  private _unregisterBuiltIn(): void {
    for (const d of this._lmTools) { d.dispose(); }
    this._lmTools = [];
    if (this._cursorRegistered) {
      try { (vscode as unknown as { cursor?: { mcp?: CursorMcpApi } }).cursor?.mcp?.unregisterServer?.(CURSOR_SERVER); } catch { /* window closing */ }
      this._cursorRegistered = false;
    }
  }

  // ── Fix with AI ───────────────────────────────────────────────────────────

  /**
   * Opens the editor's AI chat with a request to fix the test (its tools
   * fetch the details), or — where no chat can be opened — copies the
   * failure for pasting. Only on the user's click.
   */
  async fixWithAI(fileId?: string, nodeId?: string): Promise<'chat' | 'clipboard' | undefined> {
    const ctx = fileId ? this._d.projects.forFile(fileId) : this._d.projects.selected;
    let node = nodeId ? ctx?.store.getNode(nodeId) : undefined;
    if (!node && ctx && !fileId) {
      // Command Palette: the test under the cursor, else the first failure.
      const ed = vscode.window.activeTextEditor;
      const at = ed && ctx.store.getLineMap(ed.document.uri.fsPath).get(ed.selection.active.line + 1);
      node = at ? ctx.store.getNode(at.nodeId) : undefined;
      if (!node || node.status !== 'failed') {
        node = ctx.store.getAllFiles().flatMap((f) => ctx.store.getFileNodes(f.fileId)).find((n) => n.type === 'test' && n.status === 'failed');
      }
    }
    if (!ctx || !node || node.type !== 'test' || node.status !== 'failed') {
      void vscode.window.showInformationMessage('Live Test Runner: no failing test to fix.');
      return undefined;
    }
    const id = this.tools.ids.encode(node.id, node.fileId);
    const where = `${this.tools.ids.rel(node.fileId)}${node.line ? `:${node.line}` : ''}`;
    const owner = this._d.frameworkOf(node.fileId);
    const details = failuresForAI(failuresOf(ctx.store, [node.id]), owner?.framework ?? 'test framework', owner?.root ?? ctx.root, readText);

    if (this.enabled && this.builtIn === 'copilot' && await hasCommand('workbench.action.chat.open')) {
      const query = `Fix the failing test "${node.fullName}" (${where}). Use the Live Test Runner tools: #LTR_explain_failure with id "${id}" for the error, the test code and the lines it ran; fix the cause in the code (or the test, if the test is wrong); then #LTR_verify_fix to confirm it passes and nothing else broke.`;
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
        log.info(`Fix with AI: opened the chat for "${node.fullName}"`);
        return 'chat';
      } catch {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', query);
          return 'chat';
        } catch { /* no chat: copy below */ }
      }
    }
    const tools = this.enabled ? '\n\nIf you have Live Test Runner\'s LTR_ tools, call LTR_verify_fix after the fix to confirm it passes and nothing else broke.' : '';
    await vscode.env.clipboard.writeText(details + tools);
    log.info(`Fix with AI: copied "${node.fullName}" for the assistant's chat`);
    void vscode.window.showInformationMessage('Live Test Runner: the failure is copied — paste it into your AI assistant\'s chat.');
    return 'clipboard';
  }

  // ── The host the handlers read through ────────────────────────────────────

  private _host(): BridgeHost {
    const projects = this._d.projects;
    const toBridge = (ctx: ProjectContext): BridgeProject => {
      let b = this._bridgeAdapters.get(ctx);
      if (!b) { b = bridgeProject(ctx); this._bridgeAdapters.set(ctx, b); }
      return b;
    };
    const ctxOf = (p: BridgeProject) => projects.contexts.find((c) => c.id === p.id);
    return {
      projects: () => projects.contexts.map(toBridge),
      selected: () => (projects.selected ? toBridge(projects.selected) : undefined),
      folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      editorName: vscode.env.appName,
      extensionVersion: this._d.extensionVersion,
      readText,
      allowRuns: () => vscode.workspace.getConfiguration('liveTestRunner').get<AllowRuns>('ai.allowRuns', 'always'),
      confirmRun: async (what) => {
        const pick = await vscode.window.showWarningMessage(
          `Your AI assistant wants to run ${what}. Allow it?`,
          { modal: true, detail: 'Runs like ▶ Run. Change this with the liveTestRunner.ai.allowRuns setting.' },
          'Allow',
        );
        return pick === 'Allow';
      },
      announceRun: (what) => {
        log.info(`AI assistant runs ${what}`);
        vscode.window.setStatusBarMessage(`$(sparkle) Live Test Runner: your AI assistant runs ${what}`, 8000);
      },
      clearCacheAndRestart: (p) => {
        const ctx = ctxOf(p);
        if (!ctx) { return; }
        projects.select(ctx);
        void vscode.commands.executeCommand('liveTestRunner.clearCacheAndRestart');
      },
      updateSnapshot: async (_p, fileId, nodeId) => !!(await vscode.commands.executeCommand<boolean>('liveTestRunner.updateSnapshot', fileId, nodeId)),
      showResult: (_p, fileId, nodeId) => { void vscode.commands.executeCommand('liveTestRunner.focusResult', fileId, nodeId); },
      showFile: async (filePath, line) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        const l = Math.max(0, Math.min(doc.lineCount - 1, line - 1));
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(l, 0, l, 0), preview: false });
        void vscode.commands.executeCommand('liveTestRunner.showCoverageInEditor');
      },
      diagnostics: () => this._d.diagnostics(),
    };
  }

  dispose(): void {
    this._stopMailbox();
    this._unregisterBuiltIn();
    for (const d of this._disposables) { d.dispose(); }
  }
}

/** A project as the handlers see it (the session's own methods behind each action). */
function bridgeProject(ctx: ProjectContext): BridgeProject {
  const fw = (s: ReturnType<ProjectContext['services']['servicesFor']>): BridgeFramework => ({
    id: s.framework,
    displayName: s.displayName,
    coverageOff: s.coverageOffReason?.(ctx.root),
    traceOff: !s.features.trace ? `the per-test trace is not available for ${s.displayName} yet` : s.traceOffReason?.(ctx.root),
  });
  return {
    id: ctx.id,
    name: ctx.name,
    root: ctx.root,
    get frameworkLabel() { return ctx.frameworkLabel; },
    store: ctx.store,
    coverageStore: ctx.coverageStore,
    traceStore: ctx.traceStore,
    sessionActive: () => ctx.session.isActive(),
    running: () => ctx.session.isRunning(),
    discovering: () => ctx.gate.isDiscovering,
    progress: () => ctx.session.progress(),
    runsStartedAt: () => ctx.session.runsStartedAt,
    frameworks: () => {
      const all = ctx.services.all();
      return (all.length ? all : [ctx.services.servicesFor(ctx.root)]).map(fw);
    },
    frameworkOf: (filePath) => fw(ctx.services.servicesFor(filePath)),
    placements: () => {
      if (!ctx.services.isMixed()) { return undefined; }
      const out: Record<string, string> = {};
      for (const f of ctx.store.getAllFiles()) { out[f.fileId] = ctx.services.servicesFor(f.fileId).framework; }
      return out;
    },
    runScope: (args) => ctx.session.rerunScope(args),
    runFiles: (fileIds, label, cancelled) => ctx.session.runFiles(fileIds, label, cancelled),
    runChangedFiles: (files, label) => ctx.session.runChangedFiles(files, label),
  };
}

function lmResult(text: string): unknown {
  const v = vscode as unknown as {
    LanguageModelToolResult?: new (parts: unknown[]) => unknown;
    LanguageModelTextPart?: new (value: string) => unknown;
  };
  if (v.LanguageModelToolResult && v.LanguageModelTextPart) {
    return new v.LanguageModelToolResult([new v.LanguageModelTextPart(text)]);
  }
  return { content: [{ value: text }] };
}

async function hasCommand(id: string): Promise<boolean> {
  try { return (await vscode.commands.getCommands(true)).includes(id); } catch { return false; }
}

function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}
