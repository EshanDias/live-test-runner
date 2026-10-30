import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ResultStore, makeNodeId } from '../store/ResultStore';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { logger } from '../utils/logger';
import { DiscoveredStructure, DiscoveredSuite, TestFileDiscoverer, jsDiscoverer, setJsDiscoveryLogger } from './discovery/TestFileDiscoverer';

const log = logger.scope('Discovery');

setJsDiscoveryLogger(log);

/** Per-pass counters, summarised in one log line when discovery finishes. */
type DiscoveryStats = { cacheHits: number; parsed: number; noTests: number; failed: number };

export interface DiscoveryCallbacks {
  /** Called once the file list is known, before any AST parsing starts. */
  onFilesFound(total: number): void;
  /** Called once per batch with all files parsed in that batch. */
  onBatchDiscovered(files: unknown[], discovered: number, total: number): void;
  /** Called when all files have been parsed (or 0 files were found). */
  onComplete(): void;
  /** Called when a watched test file is deleted (e.g. temp files from e2e tests). */
  onFileRemoved?(fileId: string): void;
}

// Batch sizes for discovery passes.
// Cold (no cache): small batches keep UI responsive during slow Babel parse.
// Warm (cache hits): larger batches since stat+store is ~10x faster than parse.
const BATCH_SIZE_COLD = 5;
const BATCH_SIZE_WARM = 25;

/** Yields to the event loop so VS Code can process messages between batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * TestDiscoveryService — statically discovers test structure from source files.
 *
 * Lifecycle:
 *  1. `start()` — called on extension activate with `DiscoveryCallbacks`.
 *     Finds all test files, then parses their ASTs in batches.
 *     After each batch, yields to the event loop and fires `onFileDiscovered`
 *     so the UI renders incrementally.
 *     When done, sets up a FileSystemWatcher for subsequent changes.
 *
 *  2. `awaitDiscovery()` — awaited by SessionManager before a run starts.
 *     Resolves immediately if discovery is already finished.
 *
 *  3. FileSystemWatcher — re-discovers individual files on change/create
 *     (only while no session is active, so live results are never clobbered).
 */
export class TestDiscoveryService {
  private _watchers: vscode.FileSystemWatcher[] = [];
  private _discoveryPromise: Promise<void> = Promise.resolve();
  private _isDiscovering = false;
  private _hasCompleted = false;
  private _projectRoot: string | undefined;
  private _store: ResultStore | undefined;
  private _callbacks: DiscoveryCallbacks | undefined;
  private _cache: DiscoveryCache | undefined;
  private _stats: DiscoveryStats = { cacheHits: 0, parsed: 0, noTests: 0, failed: 0 };
  /** The framework's file patterns and parser (Babel for JS, the line scanner for pytest). */
  private _discoverer: TestFileDiscoverer = jsDiscoverer;

  get isDiscovering(): boolean {
    return this._isDiscovering;
  }

  get hasCompleted(): boolean {
    return this._hasCompleted;
  }

  restart(): void {
    if (!this._projectRoot || !this._store || !this._callbacks) { return; }
    this.start(this._projectRoot, this._store, this._callbacks, this._cache, this._discoverer);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Kicks off background discovery. Safe to call multiple times — a new call
   * cancels any pending watch and restarts from scratch (e.g. project root changed).
   */
  start(
    projectRoot: string,
    store: ResultStore,
    callbacks: DiscoveryCallbacks,
    cache?: DiscoveryCache,
    discoverer: TestFileDiscoverer = jsDiscoverer,
  ): void {
    this._disposeWatchers();
    this._discoverer = discoverer;
    this._isDiscovering = true;
    this._projectRoot = projectRoot;
    this._store = store;
    this._callbacks = callbacks;
    this._cache = cache;
    this._stats = { cacheHits: 0, parsed: 0, noTests: 0, failed: 0 };
    const startedAt = Date.now();

    this._discoveryPromise = this._run(projectRoot, store, callbacks, cache)
      .then((fileCount) => {
        const s = this._stats;
        const tests = store.getSummary().total;
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        const detail = [
          cache ? `${s.cacheHits} from cache` : undefined,
          `${s.parsed} parsed`,
          s.noTests ? `${s.noTests} without ${this._discoverer.testsLabel}` : undefined,
          s.failed ? `${s.failed} failed to parse` : undefined,
        ].filter(Boolean).join(', ');
        log.info(`Discovered ${tests} test(s) in ${fileCount - s.noTests - s.failed} file(s) in ${secs}s (${detail})`);
        if (s.failed > 0) {
          log.warn(`${s.failed} test file(s) could not be read or parsed and are hidden from the tree (see the warnings above)`);
        }
      })
      .catch((err) => {
        log.error(`Discovery failed for ${projectRoot}`, err);
      })
      .finally(() => {
        this._isDiscovering = false;
        this._hasCompleted = true;
        cache?.flush();
        callbacks.onComplete();
        this._setupWatcher(projectRoot, store, callbacks);
      });
  }

  /**
   * Scans every file currently in the store and removes any whose path no
   * longer exists on disk.  Call this after a test run or trace completes to
   * evict ghost entries left behind when an e2e test deletes a whole directory
   * (e.g. via rimraf) — VS Code's file-system watcher only sees the directory
   * deletion, not the individual file deletions inside it.
   */
  pruneGhostFiles(): void {
    const store = this._store;
    const callbacks = this._callbacks;
    if (!store || !callbacks) { return; }
    for (const file of store.getAllFiles()) {
      if (!fs.existsSync(file.filePath)) {
        log.debug(`Removed deleted test file from the tree: ${file.filePath}`);
        store.removeFile(file.fileId);
        callbacks.onFileRemoved?.(file.fileId);
      }
    }
  }

  /**
   * Discovers files the glob patterns missed but Jest runs (a custom testMatch
   * or testRegex — Jest's --listTests is the source of truth). Files already
   * in the tree are left alone. @returns the number of files added.
   */
  addFiles(filePaths: string[]): number {
    const store = this._store;
    const projectRoot = this._projectRoot;
    if (!store || !projectRoot) { return 0; }
    const files: unknown[] = [];
    for (const fp of filePaths) {
      if (store.findFileKey(fp) || !this._discoverer.accepts(fp) || !fs.existsSync(fp)) { continue; }
      // The framework says it runs this file: list it even when no test can be
      // found statically (tests generated at runtime) — results fill it in.
      const data = this._populateFile(fp, projectRoot, store, this._cache, true);
      if (data) { files.push(data); }
    }
    if (files.length > 0) {
      this._callbacks?.onBatchDiscovered(files, files.length, files.length);
      this._cache?.flush();
    }
    return files.length;
  }

  /**
   * Returns a promise that resolves when the current discovery pass is complete.
   * Used by SessionManager to gate "Start Testing" until the store is populated.
   */
  awaitDiscovery(): Promise<void> {
    return this._discoveryPromise;
  }

  dispose(): void {
    this._disposeWatchers();
  }

  private _disposeWatchers(): void {
    for (const w of this._watchers) { w.dispose(); }
    this._watchers = [];
  }

  // ── Private: discovery run ─────────────────────────────────────────────────

  /** @returns the number of candidate test files found. */
  private async _run(
    projectRoot: string,
    store: ResultStore,
    callbacks: DiscoveryCallbacks,
    cache?: DiscoveryCache,
  ): Promise<number> {
    // ── Step 1: find all test files (fast — native VS Code glob) ─────────────
    // One search per pattern: VS Code globs don't nest braces reliably.
    const found = new Set<string>();
    const discoverer = this._discoverer;
    for (const glob of discoverer.patterns(projectRoot)) {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(projectRoot, glob), discoverer.exclude);
      for (const u of uris) { if (discoverer.accepts(u.fsPath)) { found.add(u.fsPath); } }
    }
    const paths = [...found].sort();

    log.debug(`Found ${paths.length} candidate test file(s) under ${projectRoot}`);
    callbacks.onFilesFound(paths.length);

    if (paths.length === 0) { return 0; }

    // ── Step 2: parse ASTs in batches, yielding between each batch ───────────
    // Use larger batches when a cache is present — stat+store is ~10x faster
    // than a cold Babel parse, so we can process more files per tick without
    // blocking the UI noticeably.
    const batchSize = cache ? BATCH_SIZE_WARM : BATCH_SIZE_COLD;
    let discovered = 0;

    for (let i = 0; i < paths.length; i += batchSize) {
      // Yield before each batch so the extension host can process messages and
      // keep the UI responsive even on large projects.
      await yieldToEventLoop();

      const batch = paths.slice(i, i + batchSize);
      const batchFiles: unknown[] = [];
      for (const filePath of batch) {
        const fileData = this._populateFile(filePath, projectRoot, store, cache);
        discovered++;
        if (fileData) {
          batchFiles.push(fileData);
        }
      }
      if (batchFiles.length > 0) {
        callbacks.onBatchDiscovered(batchFiles, discovered, paths.length);
      }
    }
    return paths.length;
  }

  // ── Private: file watcher ──────────────────────────────────────────────────

  private _setupWatcher(
    projectRoot: string,
    store: ResultStore,
    callbacks: DiscoveryCallbacks,
  ): void {
    const handleChange = (uri: vscode.Uri) => {
      if (!this._discoverer.accepts(uri.fsPath) || /[\\/](node_modules|site-packages)[\\/]/.test(uri.fsPath)) { return; }
      const existing = store.getFile(uri.fsPath);
      if (existing?.status === 'running') { return; }

      // Guard against create-then-delete races: VS Code may fire onDidCreate for
      // a file that is already gone by the time we process the event (e.g. a
      // temporary test file written and deleted by an e2e test).  If the file no
      // longer exists, treat it as a deletion so it doesn't remain as a ghost.
      if (!fs.existsSync(uri.fsPath)) {
        if (existing) {
          log.debug(`File deleted before it could be re-read: ${uri.fsPath}`);
          store.removeFile(uri.fsPath);
          callbacks.onFileRemoved?.(uri.fsPath);
        }
        return;
      }

      // Clear the line map before re-discovery so that decorations are
      // correctly repositioned (orphans cleared, moves updated).
      store.clearLineMap(uri.fsPath);

      log.trace(`Re-discovering ${uri.fsPath}`);
      const fileData = this._populateFile(uri.fsPath, projectRoot, store, this._cache);
      if (fileData) {
        callbacks.onBatchDiscovered([fileData], 1, 1);
        this._cache?.flush();
      }
    };

    for (const glob of this._discoverer.patterns(projectRoot)) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectRoot, glob));
      watcher.onDidChange(handleChange);
      watcher.onDidCreate(handleChange);
      watcher.onDidDelete((uri) => {
        if (!store.getFile(uri.fsPath)) { return; }
        store.removeFile(uri.fsPath);
        callbacks.onFileRemoved?.(uri.fsPath);
      });
      this._watchers.push(watcher);
    }
  }

  // ── Private: per-file AST parse + store populate ──────────────────────────

  /**
   * Reads, parses, and populates one file. Returns the serialised FileResult
   * (ready to postMessage to a webview) or null if parsing failed.
   */
  private _populateFile(
    filePath: string,
    projectRoot: string,
    store: ResultStore,
    cache?: DiscoveryCache,
    /** Keep the file even without static tests (the framework listed it). */
    keepEmpty = false,
  ): unknown | null {
    // ── Try cache first (skip readFile + Babel if mtime unchanged) ────────────
    let result: DiscoveredStructure | null = null;

    if (cache) {
      result = (cache.get(filePath) as DiscoveredStructure | undefined) ?? null;
      if (result) { this._stats.cacheHits++; }
    }

    if (!result) {
      let source: string;
      try {
        source = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        this._stats.failed++;
        log.warn(`Could not read ${filePath}`, err);
        return null;
      }

      try {
        result = this._discoverer.discover(source, filePath, projectRoot);
      } catch (err) {
        this._stats.failed++;
        log.error(`Test discovery crashed on ${filePath}`, err);
        return null;
      }

      if (!result) {
        // testDiscovery.js already logged the parse error (or Babel load failure).
        this._stats.failed++;
        return null;
      }
      this._stats.parsed++;

      // Write to cache only for files that have actual Jest tests
      if (cache && (result.suites.length > 0 || result.rootTests.length > 0)) {
        try {
          const { mtimeMs } = fs.statSync(filePath);
          cache.set(filePath, mtimeMs, result);
        } catch { /* stat failed — skip caching this file */ }
      }
    }

    // If no tests were found (e.g. all describe/test calls are imported from a
    // non-Jest package like tstyche), skip this file entirely so it doesn't
    // appear as an empty entry in the test list.
    if (result.suites.length === 0 && result.rootTests.length === 0 && !keepEmpty) {
      this._stats.noTests++;
      log.trace(`No Jest tests in ${filePath} — skipped`);
      return null;
    }

    const relativeName = path.relative(projectRoot, filePath);
    store.fileDiscovered(filePath, filePath, relativeName);

    // Rebuild the line map from fresh AST data on every pass so edits are
    // reflected immediately (the watcher calls this on every save).
    store.clearLineMap(filePath);

    // Root-level tests (no enclosing describe) → '(root)' suite node,
    // matching the convention used by JestAdapter._applyFileResult.
    if (result.rootTests.length > 0) {
      const rootSuiteId = makeNodeId(filePath, [], '(root)');
      store.nodeDiscovered(filePath, rootSuiteId, null, 'suite', '(root)', '(root)');
      for (const t of result.rootTests) {
        const isDynamic = t.name.match(/…|%[isdjpxofc]/);
        const testId = makeNodeId(filePath, ['(root)'], t.fullName);
        store.nodeDiscovered(
          filePath,
          testId,
          rootSuiteId,
          isDynamic ? 'suite' : 'test',
          t.name,
          t.fullName,
          t.line,
          !!isDynamic
        );
        if (t.line) {
          store.setLineEntry(filePath, t.line, { nodeId: testId, fileId: filePath });
        }
      }
    }

    // Named suites — walk the recursive tree
    this._populateSuiteTree(filePath, result.suites, [], null, store);

    // Return the serialised file for the webview
    return store.serialiseFile(filePath);
  }

  /**
   * Recursively populate the store with suite nodes and their children.
   */
  private _populateSuiteTree(
    filePath: string,
    suites: DiscoveredSuite[],
    ancestorNames: string[],
    parentId: string | null,
    store: ResultStore,
  ): void {
    for (const suite of suites) {
      const isDynamic = suite.name.match(/…|%[isdjpxofc]/);
      const suiteId = makeNodeId(filePath, ancestorNames, suite.name);
      store.nodeDiscovered(
        filePath,
        suiteId,
        parentId,
        'suite',
        suite.name,
        [...ancestorNames, suite.name].join(' '),
        suite.line,
        !!isDynamic
      );
      if (suite.line) {
        store.setLineEntry(filePath, suite.line, { nodeId: suiteId, fileId: filePath });
      }

      // Populate direct test children
      const testAncestors = [...ancestorNames, suite.name];
      for (const t of suite.tests) {
        const isDynamic = t.name.match(/…|%[isdjpxofc]/);
        const testId = makeNodeId(filePath, testAncestors, t.name);
        store.nodeDiscovered(
          filePath,
          testId,
          suiteId,
          isDynamic ? 'suite' : 'test',
          t.name,
          t.fullName,
          t.line,
          !!isDynamic
        );
        if (t.line) {
          store.setLineEntry(filePath, t.line, { nodeId: testId, fileId: filePath });
        }
      }

      // Recurse into child suites
      if (suite.children && suite.children.length > 0) {
        this._populateSuiteTree(filePath, suite.children, testAncestors, suiteId, store);
      }
    }
  }
}
