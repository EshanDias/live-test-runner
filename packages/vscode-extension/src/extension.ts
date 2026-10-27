/**
 * extension.ts — activation entry point.
 *
 * This file is intentionally thin. Its only job is to:
 *  1. Create all service/provider instances
 *  2. Register VS Code commands and event subscriptions
 *  3. Hand control to SessionManager for all run logic
 *
 * No test-running logic, no framework classes, no status bar text — those
 * live in SessionManager and the framework services bundle
 * (framework/jestServices.ts) respectively.
 */
import * as vscode from 'vscode';
import { openGuide } from './views/GuidePanel';
import * as fs from 'fs';
import * as path from 'path';
import { LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR } from './constants';
import { ResultStore } from './store/ResultStore';
import { ExecutionTraceStore } from './store/ExecutionTraceStore';
import { SelectionState } from './store/SelectionState';
import { CodeLensProvider } from './editor/CodeLensProvider';
import { DecorationManager } from './editor/DecorationManager';
import { ExplorerView } from './views/ExplorerView';
import { ResultsView } from './views/ResultsView';
import { SessionManager } from './session/SessionManager';
import { ProjectRegistry } from './project/ProjectRegistry';
import { ProjectContext } from './project/ProjectContext';
import { FileStores } from './editor/FileStores';
import { IResultObserver } from './IResultObserver';
import { IInstrumentedRunner } from './timeline/IInstrumentedRunner';
import { TimelineDecorationManager } from './timeline/TimelineDecorationManager';
import { rotateAndCheckCapacity } from './cache/DiscoveryCache';
import { CoverageStore } from './coverage/CoverageStore';
import { CoverageDecorationManager } from './editor/CoverageDecorationManager';
import { CoverageHoverProvider } from './editor/CoverageHoverProvider';
import { logger } from './utils/logger';
import { buildDiagnosticReport } from './utils/diagnostics';

const log = logger.scope('Extension');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Alive but no permission to signal
  }
}

export function activate(context: vscode.ExtensionContext) {
  // ── Output channels (created first so every later log line has a home) ─────
  // "Live Test Runner"             — structured, levelled extension log
  // "Live Test Runner: Test Output" — raw test-runner process output, ANSI-stripped
  const logChannel    = vscode.window.createOutputChannel('Live Test Runner', { log: true });
  const outputChannel = vscode.window.createOutputChannel('Live Test Runner: Test Output');
  logger.init(logChannel);

  // End-to-end tests (e2e/ at the repo root) read the raw Jest output.
  const e2eRawOutput: string[] | undefined = process.env.LTR_E2E ? [] : undefined;
  if (e2eRawOutput) {
    const appendLine = outputChannel.appendLine.bind(outputChannel);
    outputChannel.appendLine = (line: string) => { e2eRawOutput.push(line); appendLine(line); };
  }

  const extVersion = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
  log.info(
    `Live Test Runner v${extVersion} · VS Code ${vscode.version} · ${process.platform}-${process.arch} · Node ${process.versions.node}`,
  );

  // Ensure the shared base directories exist up front so no path checks fail later.
  for (const dir of [LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error(`Could not create ${dir}`, err);
    }
  }

  // Clean up stale session directories from previous or crashed windows.
  let removedDirs = 0;
  try {
    for (const entry of fs.readdirSync(LTR_BASE_TMP_DIR)) {
      const fullPath = path.join(LTR_BASE_TMP_DIR, entry);

      // Handle new-style session directories: session-<pid>-<timestamp>
      const sessionMatch = entry.match(/^session-(\d+)-/);
      if (sessionMatch) {
        const pid = parseInt(sessionMatch[1], 10);
        if (!isProcessAlive(pid)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs++;
        }
        continue;
      }

      // Handle legacy trace directories (blindly clean up to migrate)
      if (entry.startsWith('traces-')) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedDirs++;
      }
    }
  } catch (err) {
    log.warn('Stale session cleanup failed — continuing', err);
  }
  if (removedDirs > 0) { log.debug(`Removed ${removedDirs} stale session folder(s) from ${LTR_BASE_TMP_DIR}`); }

  // Create a unique isolated directory for THIS session.
  const sessionDirName = `session-${process.pid}-${Date.now()}`;
  const LTR_SESSION_TMP_DIR = path.join(LTR_BASE_TMP_DIR, sessionDirName);
  try {
    fs.mkdirSync(LTR_SESSION_TMP_DIR, { recursive: true });
    log.debug(`Session temp folder: ${LTR_SESSION_TMP_DIR}`);
  } catch (err) {
    log.error(`Could not create session temp folder ${LTR_SESSION_TMP_DIR} — runs will fail`, err);
  }

  // ── Infrastructure ─────────────────────────────────────────────────────────
  const statusBar      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command    = 'liveTestRunner.showPanels';
  statusBar.text       = 'Live Tests: Off';
  statusBar.show();

  // ── State ──────────────────────────────────────────────────────────────────
  // Every store lives in a ProjectContext (one per test project, phase 7).
  // Views start on an empty placeholder and are bound to the selected project.
  const selection     = new SelectionState();
  const emptyStore    = new ResultStore();
  const emptyCoverage = new CoverageStore();
  const emptyTrace    = new ExecutionTraceStore();

  // ── Views and editor providers ─────────────────────────────────────────────
  const explorerView      = new ExplorerView(context.extensionUri, emptyStore, selection, emptyCoverage);
  const resultsView       = new ResultsView(context.extensionUri, emptyStore, selection);
  // Explorer + Results follow the selected project; editor features decorate
  // every file from its own project and hear every project's events.
  const observers: IResultObserver[] = [explorerView, resultsView];
  const editorObservers: Partial<IResultObserver>[] = [];
  // Called only after the registry below exists (never during construction).
  const storesOf = (filePath: string): FileStores | undefined => projects.forFile(filePath);
  const decorationManager = new DecorationManager(storesOf, context);
  const codeLensProvider  = new CodeLensProvider(storesOf);
  editorObservers.push(decorationManager, codeLensProvider);

  // Register CodeLens immediately so ▶ Run / ▷ Debug appear as soon as
  // discovery populates the line map — no need to click Start Testing first.
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      // Any file can carry lenses — they only appear where discovery mapped tests.
      { scheme: 'file', pattern: '**/*.{js,ts,jsx,tsx,mjs,cjs,mts,cts}' },
      codeLensProvider,
    ),
  );

  // When selection changes, push scoped logs to the results view
  const origSelect = selection.select.bind(selection);
  selection.select = (sel) => {
    origSelect(sel);
    resultsView.sendScopedData(sel.fileId, sel.nodeId);
  };

  // ── Coverage decoration manager ───────────────────────────────────────────
  const coverageDecoMgr = new CoverageDecorationManager(storesOf);
  editorObservers.push(coverageDecoMgr);
  context.subscriptions.push(emptyCoverage, coverageDecoMgr);

  // ── Projects ───────────────────────────────────────────────────────────────
  // Every test project of the workspace is detected; none runs until started.
  const projects = new ProjectRegistry({
    sessionDir: LTR_SESSION_TMP_DIR,
    cacheRootDir: LTR_BASE_CACHE_DIR,
    outputChannel,
    observers,
    editorObservers,
    selection,
    sendScopedData: (fileId, nodeId) => resultsView.sendScopedData(fileId, nodeId),
    statusBar,
    memento: context.workspaceState,
  });
  /** The project the views show; Start / Stop act on it. */
  const sel = (): ProjectContext | undefined => projects.selected;
  /** The project a file belongs to, else the selected one. */
  const owner = (filePath: string | undefined): ProjectContext | undefined =>
    (filePath ? projects.forFile(filePath) : undefined) ?? projects.selected;

  // ── Timeline debugger ──────────────────────────────────────────────────────
  // Reference typed as the interface — never as the concrete class. It hands
  // each run to the project's framework, which may not have one yet.
  const instrumentedRunner: IInstrumentedRunner = {
    run: (options) => {
      const ctx = projects.forFile(options.filePath) ?? projects.contexts.find((c) => c.root === options.projectRoot) ?? sel();
      if (!ctx) { return Promise.reject(new Error('No test project for this file.')); }
      // The test file's own framework (a mixed project has two).
      const services = ctx.services.servicesFor(options.filePath);
      if (!services.instrumentedRunner) {
        return Promise.reject(new Error(`The Timeline debugger is not available for ${services.displayName} yet.`));
      }
      return services.instrumentedRunner.run(options);
    },
    cancel: () => { for (const c of projects.contexts) { for (const s of c.services.all()) { s.instrumentedRunner?.cancel(); } } },
  };
  const timelineDecorations = new TimelineDecorationManager();

  // Last timeline run context, used by the Re-run button in the sidebar.
  let lastTimelineOptions: { filePath: string; testFullName: string } | null = null;

  // Last serialised store — kept so TimelineDecorationManager can render inline values.
  let lastTimelineStore: { steps: unknown[]; variables: Record<number, unknown[]> } | null = null;
  /** The panels show the Timeline (a project switch leaves it first). */
  let timelineOpen = false;

  const currentStore = (): ResultStore => sel()?.store ?? emptyStore;

  const routeExplorerToMain = () => {
    timelineOpen = false;
    const summary = currentStore().getSummary();
    explorerView.postMessage({
      type: 'route',
      view: 'testList',
      payload: {
        files: (currentStore().toJSON() as { files: unknown[] }).files,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        sessionActive: explorerView.sessionActive,
        projects: projects.summaries(),
      },
    });
  };
  const routeResultsToMain = () => {
    resultsView.postMessage({
      type: 'route',
      view: 'results',
      payload: {
        files: (currentStore().toJSON() as { files: unknown[] }).files,
      },
    });
  };

  // Forward step-changed from ResultsView to ExplorerView (sidebar state update)
  // and apply the editor highlight with inline variable values.
  resultsView.onStepChanged = (stepId, filePath, line) => {
    explorerView.postMessage({ type: 'step-update', stepId });
    if (lastTimelineStore) {
      timelineDecorations.applyStep(
        filePath,
        line,
        lastTimelineStore as Parameters<typeof timelineDecorations.applyStep>[2],
        stepId,
      ).catch((err) => {
        log.warn(`Timeline: could not decorate step ${stepId} at ${filePath}:${line}`, err);
      });
    } else {
      timelineDecorations.highlight(filePath, line).catch((err) => {
        log.warn(`Timeline: could not highlight ${filePath}:${line}`, err);
      });
    }
  };

  // Wire Add-to-Watch from hover → ExplorerView sidebar.
  timelineDecorations.onAddToWatch = (varName) => {
    explorerView.postMessage({ type: 'add-to-watch', varName });
  };

  // Clear decorations when the user navigates away from timeline mode.
  resultsView.onTimelineExit = () => {
    timelineDecorations.clearAll();
    routeExplorerToMain();
  };
  resultsView.onTimelineExitRequest = () => {
    routeResultsToMain();
    routeExplorerToMain();
  };
  explorerView.onTimelineExitRequest = () => {
    timelineDecorations.clearAll();
    routeResultsToMain();
    routeExplorerToMain();
  };

  // Re-run button in the sidebar.
  explorerView.onTimelineRerun = () => {
    if (!lastTimelineOptions) { return; }
    timelineOpen = true;
    openTimelineDebugger(
      lastTimelineOptions.filePath,
      lastTimelineOptions.testFullName,
      owner(lastTimelineOptions.filePath)?.root,
      instrumentedRunner,
      resultsView,
      explorerView,
      lastTimelineOptions,
      (s) => { lastTimelineStore = s; },
    );
  };

  // ── Coverage hover provider ────────────────────────────────────────────────
  const coverageHoverProvider = new CoverageHoverProvider(storesOf, (filePath) => {
    const ctx = owner(filePath);
    if (!ctx) { return undefined; }
    const services = ctx.services.servicesFor(filePath);
    if (!services.features.trace) { return `covering tests are not available for ${services.displayName} yet`; }
    const off = services.traceOffReason?.(ctx.root);
    return off ? `covering tests are off for this project — ${off}` : undefined;
  });
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      // Any file: whatever the tests ran has coverage (the provider answers only where there is some).
      { scheme: 'file' },
      coverageHoverProvider,
    ),
  );

  // ── Switching projects: bind every view to the selected project's stores ───
  context.subscriptions.push(
    projects.onDidChangeSelection((ctx) => {
      if (timelineOpen) {
        timelineDecorations.clearAll();
        routeResultsToMain();
        routeExplorerToMain();
      }
      selection.clear();
      const state = ctx?.viewState() ?? {
        store: emptyStore, coverageStore: emptyCoverage, traceStore: emptyTrace,
        sessionActive: false, isDiscovering: false, discoveryTotal: 0, discoveryDone: 0,
      };
      explorerView.setProjects(projects.summaries());
      explorerView.bindProject(state);
      resultsView.bindProject(state);
      // Editor features are per file, not per selection — only the project list may have changed.
      coverageDecoMgr.watch(projects.contexts.map((c) => c.coverageStore));
      decorationManager.refresh();
      codeLensProvider.refresh();
      // Coverage badge / tab of the newly shown project.
      explorerView.onCoverageUpdated(state.coverageStore.getTotals(), state.coverageStore.getFileRows());
    }),
    projects.onDidChangeProjects(() => explorerView.setProjects(projects.summaries())),
    projects,
  );
  projects.refresh();

  _releaseDiscoveryLock = () => { for (const c of projects.contexts) { c.discoveryCache?.releaseLock(); } };
  _cleanTraceDir = () => { for (const c of projects.contexts) { c.cleanTraceDir(); } };

  /** The selected project, or an error message offering Select Project Root. */
  async function requireProject(): Promise<ProjectContext | undefined> {
    const ctx = sel();
    if (ctx) { return ctx; }
    log.warn('Start Testing: no test project — open a folder or set liveTestRunner.projectRoot');
    const pick = await vscode.window.showErrorMessage(
      'No test project found. Open a folder with a package.json or configure liveTestRunner.projectRoot.',
      'Select Project Root',
    );
    if (pick) { await selectProjectRoot(projects); }
    return undefined;
  }

  /** Start / restart one project's session (D11: the running-projects limit applies to new starts). */
  async function startProject(ctx: ProjectContext): Promise<void> {
    const refusal = projects.startRefusal(ctx);
    if (refusal) {
      log.info(`Start Testing "${ctx.name}": ${refusal}`);
      void vscode.window.showWarningMessage(`Live Test Runner: ${refusal}`);
      return;
    }
    // Check cache capacity before starting — evict stale projects or warn.
    if (ctx.discoveryCache) {
      const cap = rotateAndCheckCapacity(LTR_BASE_CACHE_DIR);
      if (!cap.ok) {
        const choice = await vscode.window.showWarningMessage(
          `Live Test Runner cache is using ${cap.totalMb} MB across ${cap.activeCount} active sessions (limit: 500 MB). ` +
          `No inactive projects can be evicted right now. Close unused VS Code windows to free space, or continue without caching this session.`,
          'Continue Without Cache',
          'Cancel',
        );
        if (choice !== 'Continue Without Cache') { return; }
        // Run without cache this session
        ctx.discoveryCache.releaseLock();
        ctx.discoveryCache = undefined;
      }
    }
    ctx.ensureDiscovery();
    ctx.cleanTraceDir();
    return ctx.session.start();
  }

  /**
   * Stops the project's session and forgets everything it knew: results,
   * traces and the discovery cache. The views are resynced to the empty store
   * (the next discovery / Start refills them).
   */
  async function stopAndClear(ctx: ProjectContext): Promise<void> {
    ctx.session.stop(decorationManager);
    ctx.store.clearAll();
    ctx.cleanTraceDir();
    if (ctx.discoveryCache) {
      ctx.discoveryCache.releaseLock();
      ctx.discoveryCache.clear();
      ctx.discoveryCache.writeLock();
    }
    // Yield so session-stopped is processed by the webview before we send init
    await new Promise<void>((r) => setTimeout(r, 0));
    resultsView.syncNow();
    explorerView.syncNow();
  }

  /** A project by id (root) or name for command arguments; else the selected one. */
  const byArg = (id: unknown): ProjectContext | undefined =>
    typeof id === 'string' && id ? projects.contexts.find((c) => c.id === id || c.name === id) : sel();

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerView.viewId, explorerView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, resultsView, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('liveTestRunner.startTesting', async (projectId?: unknown) => {
      const ctx = typeof projectId === 'string' ? byArg(projectId) : await requireProject();
      if (!ctx) { return; }
      return startProject(ctx);
    }),
    vscode.commands.registerCommand('liveTestRunner.stopTesting', (projectId?: unknown) => {
      const ctx = byArg(projectId);
      ctx?.session.stop(decorationManager);
    }),
    vscode.commands.registerCommand('liveTestRunner.stopAllProjects', () => {
      for (const c of projects.contexts) { if (c.session.isActive() || c.session.isRunning()) { c.session.stop(decorationManager); } }
    }),
    vscode.commands.registerCommand('liveTestRunner.stopAndClearCache',  async () => {
      const ctx = sel();
      if (!ctx) { return; }
      await stopAndClear(ctx);
      log.info('Session stopped and discovery cache cleared');
    }),
    vscode.commands.registerCommand('liveTestRunner.clearCacheAndRestart', async () => {
      const ctx = sel();
      if (!ctx) { return; }
      await stopAndClear(ctx);
      log.info('Discovery cache cleared — rediscovering tests and restarting');
      // Start waits for the fresh discovery, then runs everything.
      ctx.startDiscovery();
      return startProject(ctx);
    }),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot',  () => selectProjectRoot(projects)),
    vscode.commands.registerCommand('liveTestRunner.selectProject',      async (projectId?: unknown) => {
      if (typeof projectId === 'string' && projectId) {
        const ctx = projects.select(projectId);
        if (!ctx) { log.warn(`Select Project: no project "${projectId}"`); }
        return ctx?.id;
      }
      return pickProject(projects);
    }),
    vscode.commands.registerCommand('liveTestRunner.showOutput',         () => outputChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.showLogs',           () => logChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.openGuide',          () => openGuide(context.extensionUri)),
    vscode.commands.registerCommand('liveTestRunner.copyDiagnostics',    async () => {
      const ctx = sel();
      const report = buildDiagnosticReport({
        extensionVersion: extVersion,
        projectRoot:      ctx?.root,
        sessionActive:    !!ctx?.session.isActive(),
        sessionDir:       ctx?.sessionDir ?? LTR_SESSION_TMP_DIR,
        summary:          currentStore().getSummary(),
        logLevel:         logger.level,
        recentLogLines:   logger.recentLines(),
        projects:         projects.contexts.map((c) => `${c.name} · ${c.frameworkLabel} · ${c.runState} · ${c.root}`),
      });
      await vscode.env.clipboard.writeText(report);
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(
        'Live Test Runner: diagnostic report copied to the clipboard. Check it for anything private before sharing.',
      );
    }),
    vscode.commands.registerCommand('liveTestRunner.showPanels',         () => {
      vscode.commands.executeCommand('liveTestRunner.explorer.focus');
      vscode.commands.executeCommand('liveTestRunner.results.focus');
    }),
    vscode.commands.registerCommand('liveTestRunner.rerunScope',         (args) => owner(args?.fileId)?.session.rerunScope(args)),
    vscode.commands.registerCommand('liveTestRunner.rerunFromEditor',    (filePath, line) => {
      const ctx = owner(filePath);
      return ctx && rerunFromEditor(filePath, line, ctx.store, ctx.session);
    }),
    vscode.commands.registerCommand('liveTestRunner.debugFromEditor',    (filePath, line) => {
      const ctx = owner(filePath);
      return ctx && debugFromEditor(filePath, line, ctx.store, ctx.session);
    }),
    vscode.commands.registerCommand('liveTestRunner.focusResult',        (fileId, nodeId) => {
      const ctx = owner(fileId);
      if (ctx) { projects.select(ctx); focusResult(fileId, nodeId, ctx.store, selection, resultsView); }
    }),
    vscode.commands.registerCommand('liveTestRunner.revealTestInPanel',  (args: { testFileId: string; fullName: string }) => {
      const ctx = owner(args.testFileId);
      const node = ctx?.store.findNodeByFullName(args.testFileId, args.fullName);
      if (ctx && node) { projects.select(ctx); focusResult(node.fileId, node.id, ctx.store, selection, resultsView); }
    }),
    vscode.commands.registerCommand('liveTestRunner.openTestFile',       async (args: { testFileId: string; fullName: string }) => {
      const node = owner(args.testFileId)?.store.findNodeByFullName(args.testFileId, args.fullName);
      const targetLine = node?.line != null ? node.line - 1 : 0; // VS Code range is 0-based
      const uri = vscode.Uri.file(args.testFileId);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(targetLine, 0, targetLine, 0),
        preserveFocus: false,
      });
    }),
    vscode.commands.registerCommand('liveTestRunner.showCoveringTests',   async (args: { filePath: string; line: number }) => {
      const ctx = owner(args.filePath);
      if (!ctx) { return; }
      const store = ctx.store;
      const tests = ctx.traceStore.getTestsForLine(args.filePath, args.line);
      if (tests.length === 0) { return; }

      const goToFileBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('go-to-file'),
        tooltip: 'Open test file',
      };

      type Item = vscode.QuickPickItem & { testFileId: string; fullName: string };
      const items: Item[] = tests.map(({ testFileId, fullName }) => {
        const node   = store.findNodeByFullName(testFileId, fullName);
        const status = node?.status ?? 'pending';
        const icon   = status === 'passed' ? '$(testing-passed-icon)' : status === 'failed' ? '$(testing-failed-icon)' : '$(testing-queued-icon)';
        const detail = testFileId.replace(/\\/g, '/').split('/').pop() ?? testFileId;
        return { label: `${icon} ${fullName}`, detail, buttons: [goToFileBtn], testFileId, fullName };
      });

      const qp = vscode.window.createQuickPick<Item>();
      qp.title        = `Tests covering line ${args.line} (${tests.length})`;
      qp.placeholder  = 'Select a test to reveal in the panel';
      qp.matchOnDetail = true;
      qp.items        = items;

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        if (picked) {
          const node = store.findNodeByFullName(picked.testFileId, picked.fullName);
          if (node) { projects.select(ctx); focusResult(node.fileId, node.id, store, selection, resultsView); }
        }
        qp.dispose();
      });

      qp.onDidTriggerItemButton(async ({ item }) => {
        const node       = store.findNodeByFullName(item.testFileId, item.fullName);
        const targetLine = node?.line != null ? node.line - 1 : 0;
        const uri        = vscode.Uri.file(item.testFileId);
        const doc        = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          selection:     new vscode.Range(targetLine, 0, targetLine, 0),
          preserveFocus: false,
        });
        qp.dispose();
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
    vscode.commands.registerCommand('liveTestRunner.openTimelineDebugger', (filePath: string, testFullName: string) => {
      lastTimelineOptions = { filePath, testFullName };
      timelineOpen = true;
      return openTimelineDebugger(filePath, testFullName, owner(filePath)?.root, instrumentedRunner, resultsView, explorerView, lastTimelineOptions,
        (s) => { lastTimelineStore = s; });
    }),

    // Timeline hover actions
    vscode.commands.registerCommand('liveTestRunner.addToWatch', (varName: string) => {
      explorerView.postMessage({ type: 'add-to-watch', varName });
    }),
    vscode.commands.registerCommand('liveTestRunner.copyValue', (value: string) => {
      void vscode.env.clipboard.writeText(value);
    }),
    vscode.commands.registerCommand('liveTestRunner.dumpTraceStore', () => {
      logChannel.info(sel()?.traceStore.dump() ?? '(no project)');
      logChannel.show();
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) { return; }
      // A file of a project not discovered yet: discover it so its gutter / CodeLens appear (nothing runs).
      projects.forFile(editor.document.uri.fsPath)?.ensureDiscovery();
      codeLensProvider.refresh();
    }),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        projects.forFile(editor.document.uri.fsPath)?.ensureDiscovery();
        decorationManager.applyToEditor(editor);
      }
    }),

    // Each project reruns its own files (a project in the background too).
    vscode.workspace.onDidSaveTextDocument((doc) => owner(doc.uri.fsPath)?.session.onSave(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { projects.refresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('liveTestRunner.projectRoot')) { projects.refresh(); }
    }),

    outputChannel,
    statusBar,
    { dispose: () => timelineDecorations.dispose() },
    { dispose: () => logger.dispose() },
    logChannel,
  );

  // Internals for the end-to-end tests only — never returned in normal use.
  // Store / session / … are the selected project's (getters: they follow a switch).
  if (e2eRawOutput) {
    return {
      get store() { return sel()?.store; },
      get session() { return sel()?.session; },
      get traceStore() { return sel()?.traceStore; },
      get coverageStore() { return sel()?.coverageStore; },
      get discovery() { return sel()?.discovery; },
      get sessionDir() { return sel()?.sessionDir ?? LTR_SESSION_TMP_DIR; },
      projects,
      observers, editorObservers, decorationManager, codeLensProvider, statusBar, instrumentedRunner, logger, rawOutput: e2eRawOutput,
      explorerView,
    };
  }
  return undefined;
}

let _cleanTraceDir: (() => void) | undefined;
let _releaseDiscoveryLock: (() => void) | undefined;

export function deactivate() {
  _cleanTraceDir?.();
  _releaseDiscoveryLock?.();
}

/**
 * "Select Project Root": pins the window to one folder (the 3.0 behaviour,
 * the liveTestRunner.projectRoot setting) — or, when pinned, back to every
 * detected project.
 */
async function selectProjectRoot(projects: ProjectRegistry): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('No workspace folders are open.');
    return;
  }
  const config = vscode.workspace.getConfiguration('liveTestRunner');
  const pinned = config.get<string>('projectRoot')?.trim();
  const roots = [...new Set([...projects.contexts.map((c) => c.root), ...folders.map((f) => f.uri.fsPath)])];
  type Item = vscode.QuickPickItem & { root: string };
  const items: Item[] = [
    ...(pinned ? [{ label: '$(search) Detect all projects', description: 'clear liveTestRunner.projectRoot', root: '' }] : []),
    ...roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
  ];
  const selected =
    items.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, { placeHolder: 'Select the project root Live Test Runner uses (pins the window to it)' });
  if (selected) {
    await config.update('projectRoot', selected.root || undefined, vscode.ConfigurationTarget.Workspace);
  }
}

/** "Select Project": the switcher as a quick pick. @returns the selected project's id. */
async function pickProject(projects: ProjectRegistry): Promise<string | undefined> {
  if (projects.contexts.length === 0) {
    vscode.window.showInformationMessage('Live Test Runner: no test project found in this workspace.');
    return undefined;
  }
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = projects.summaries().map((p) => ({
    label: `${p.selected ? '$(check) ' : ''}${p.name}`,
    description: [p.framework, p.relPath].filter(Boolean).join(' · '),
    detail: p.state === 'idle' ? (p.total ? `${p.total} tests` : undefined)
      : `${p.state === 'watching' ? '● live' : p.state === 'running' ? '● running' : '⟳ discovering'}${p.passed + p.failed ? ` · ✓${p.passed} ✗${p.failed}` : ''}`,
    id: p.id,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Show a test project (Start / Stop act on it)', matchOnDescription: true });
  if (picked) { projects.select(picked.id); }
  return projects.selected?.id;
}

// ── Editor commands ───────────────────────────────────────────────────────────
// These live here (not in SessionManager) because they need both the store
// and the session — thin glue that reads store state then delegates to session.

async function rerunFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<void> {
  try {
    const entry = store.getLineMap(filePath).get(line);
    if (entry) {
      const node = store.getNode(entry.nodeId);
      if (node) {
        log.debug(`Rerun from editor: ${node.type} "${node.fullName}"`);
        session.rerunScope({ scope: node.type, fileId: entry.fileId, nodeId: entry.nodeId, fullName: node.fullName });
        return;
      }
    }
    // describe blocks might not be in the LineMap at this exact line.
    // Try to extract the suite title from the source line and find the matching node.
    const nodeId = await _resolveNodeAtLine(filePath, line, store);
    if (nodeId) {
      const node = store.getNode(nodeId);
      log.debug(`Rerun from editor: suite "${node?.fullName}"`);
      session.rerunScope({ scope: 'suite', fileId: filePath, nodeId, fullName: node?.fullName });
      return;
    }
    log.debug(`Rerun from editor: no test at ${path.basename(filePath)}:${line} — running the whole file`);
    session.rerunScope({ scope: 'file', fileId: filePath });
  } catch (err) {
    log.error(`Rerun from editor failed for ${filePath}:${line}`, err);
  }
}

async function debugFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<vscode.DebugConfiguration | undefined> {
  try {
    const entry = store.getLineMap(filePath).get(line);
    const nodeId = entry?.nodeId ?? await _resolveNodeAtLine(filePath, line, store);
    const node = nodeId ? store.getNode(nodeId) : undefined;
    // A suite (describe block or .each template) runs every test inside it.
    return await session.debugFromEditor(filePath, node?.fullName, node ? node.type === 'suite' : false);
  } catch (err) {
    log.error(`Debug from editor failed for ${filePath}:${line}`, err);
    return undefined;
  }
}

/** Extracts the describe title from a source line and looks it up in the store's node pool. */
async function _resolveNodeAtLine(
  filePath: string,
  line: number,
  store: ResultStore,
): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const lineText = doc.lineAt(line - 1).text;
    const m = lineText.match(/describe\s*[.(]\s*['"`]([^'"`]+)['"`]/);
    if (!m) { return undefined; }
    // Search all nodes in this file for one matching the describe name
    const allNodes = store.getFileNodes(filePath);
    const match = allNodes.find(n => n.type === 'suite' && n.name === m[1]);
    return match?.id;
  } catch (err) {
    log.debug(`Could not resolve a describe block at ${filePath}:${line} — ${(err as Error).message}`);
    return undefined;
  }
}

async function openTimelineDebugger(
  filePath: string,
  testFullName: string,
  projectRoot: string | undefined,
  runner: IInstrumentedRunner,
  resultsView: ResultsView,
  explorerView: ExplorerView,
  _optionsRef?: { filePath: string; testFullName: string },
  onStoreReady?: (store: { steps: unknown[]; variables: Record<number, unknown[]> }) => void,
): Promise<void> {
  if (!projectRoot) {
    vscode.window.showErrorMessage(
      'Live Test Runner: Cannot open Timeline Debugger — no project root configured.',
    );
    return;
  }

  // Route both panels to their timeline views and show a loading state.
  resultsView.postMessage({ type: 'route', view: 'timeline', payload: { testFullName, filePath } });
  explorerView.postMessage({ type: 'route', view: 'timelineSidebar', payload: { testFullName } });
  resultsView.postMessage({ type: 'timeline-loading' });

  const tlog = logger.scope('Timeline');
  const startedAt = Date.now();
  tlog.info(`Tracing "${testFullName}" (${path.basename(filePath)})`);

  try {
    const store = await runner.run({ filePath, testFullName, projectRoot });

    // Convert Maps to plain objects for postMessage serialisation (Maps are not
    // JSON-serialisable and webviews receive messages via JSON.stringify).
    const serialisableStore = {
      ...store,
      variables: Object.fromEntries(store.variables),
      logs:      Object.fromEntries(store.logs),
    };

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (store.steps.length === 0) {
      // Nothing recorded almost always means the test name pattern matched no
      // test, or the trace transform did not apply to the file.
      tlog.warn(`Trace finished in ${secs}s but captured 0 steps for "${testFullName}" — see "Live Test Runner: Test Output" for Jest's output`);
    } else {
      tlog.info(`Trace done in ${secs}s — ${store.steps.length} steps, ${store.errors.length} error(s)`);
    }
    onStoreReady?.(serialisableStore as { steps: unknown[]; variables: Record<number, unknown[]> });
    resultsView.postMessage({ type: 'timeline-ready', store: serialisableStore });
    explorerView.postMessage({ type: 'timeline-ready', store: serialisableStore });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tlog.error(`Trace failed for "${testFullName}"`, err);
    vscode.window.showErrorMessage(`Timeline Debugger error: ${message}`);
    resultsView.postMessage({ type: 'timeline-error', message });
  }
}

function focusResult(
  fileId: string,
  nodeId: string,
  store: ResultStore,
  selection: SelectionState,
  resultsView: ResultsView,
): void {
  vscode.commands.executeCommand('liveTestRunner.results.focus');
  const node = store.getNode(nodeId);
  const scope = node?.type === 'test' ? 'test' : node?.type === 'suite' ? 'suite' : 'file';
  selection.select({ scope, fileId, nodeId });
  resultsView.postMessage({ type: 'scope-changed', scope, fileId, nodeId });
}
