/**
 * ResultStore — typed in-memory result tree for the custom UI.
 *
 * Intentionally has no VS Code or framework imports — it is pure data.
 * The extension layer writes to it (via JestAdapter._applyFileResult) and
 * reads from it (via views and DecorationManager).
 *
 * Hierarchy: File → Node tree (recursive, unlimited nesting)
 * All IDs are stable string keys derived from file path + ancestor chain.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** Location index only — status and duration are read live from the node pool. */
export type LineEntry = {
  nodeId: string;
  fileId: string;
};

export type TestStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

export type OutputLevel = 'log' | 'info' | 'warn' | 'error';

export interface OutputLine {
  text: string;
  level: OutputLevel;
  timestamp: number;
}

export interface ScopedOutput {
  lines: OutputLine[];
  /** Date.now() when this batch was stored. null = never run at this scope. */
  capturedAt: number | null;
}

const EMPTY_OUTPUT: ScopedOutput = { lines: [], capturedAt: null };

export type NodeType = 'suite' | 'test';

export interface TestNode {
  id: string;
  type: NodeType;
  name: string;
  /** Full display name including ancestor suite titles — used to scope reruns */
  fullName: string;

  fileId: string;
  parentId: string | null;
  children: string[];

  status: TestStatus;
  duration?: number;
  /** 1-based source line reported by the framework or AST */
  line?: number;

  output: ScopedOutput;
  failureMessages: string[];
}

export interface FileResult {
  fileId: string; // absolute file path
  filePath: string;
  name: string; // relative display name
  status: TestStatus;
  duration?: number;
  /** Console output captured during this file's run */
  output: ScopedOutput;
  /** IDs of nodes that are direct children of this file (no parent suite) */
  rootNodeIds: string[];
}

// ── Node ID helper ─────────────────────────────────────────────────────────────

const MAX_ID_LEN = 500;

/**
 * Build a stable node ID from file path + ancestor names + node name.
 * Truncates at 500 chars with a hash suffix if absurdly long.
 */
export function makeNodeId(
  filePath: string,
  ancestorNames: string[],
  name: string,
): string {
  const raw = [filePath, ...ancestorNames, name].join('::');
  if (raw.length <= MAX_ID_LEN) {
    return raw;
  }
  const hash = simpleHash(raw).toString(36);
  return raw.slice(0, MAX_ID_LEN - 12) + '::' + hash;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── Store ──────────────────────────────────────────────────────────────────────

export class ResultStore {
  private files: Map<string, FileResult> = new Map();
  private nodes: Map<string, TestNode> = new Map();
  // key: absolute filePath → Map<1-based lineNumber, LineEntry>
  private _lineMap: Map<string, Map<number, LineEntry>> = new Map();

  // Running summary counter — updated incrementally, read in O(1)
  private _summary = {
    total: 0,
    passed: 0,
    failed: 0,
    running: 0,
    totalDuration: 0,
  };

  // ── Mutations ──────────────────────────────────────────────────────────────

  clear(): void {
    this.files.clear();
    this.nodes.clear();
    this._summary = { total: 0, passed: 0, failed: 0, running: 0, totalDuration: 0 };
  }

  /**
   * Removes a single file entry, its nodes, and its line map. Used by
   * TestDiscoveryService to force a fresh re-discovery of a file.
   */
  removeFile(fileId: string): void {
    const file = this.files.get(fileId);
    if (file) {
      // Remove all nodes belonging to this file
      for (const [nodeId, node] of this.nodes) {
        if (node.fileId === fileId) {
          if (node.type === 'test') {
            this._adjustSummary(node.status, -1);
          }
          this.nodes.delete(nodeId);
        }
      }
      this.files.delete(fileId);
    }
    this._lineMap.delete(fileId);
  }

  // ── LineMap ────────────────────────────────────────────────────────────────

  setLineEntry(filePath: string, line: number, entry: LineEntry): void {
    if (!this._lineMap.has(filePath)) {
      this._lineMap.set(filePath, new Map());
    }
    this._lineMap.get(filePath)!.set(line, entry);
  }

  getLineMap(filePath: string): Map<number, LineEntry> {
    return this._lineMap.get(filePath) ?? new Map();
  }

  clearLineMap(filePath: string): void {
    this._lineMap.delete(filePath);
  }

  clearAllLineMaps(): void {
    this._lineMap.clear();
  }

  // ── Mark running ──────────────────────────────────────────────────────────

  /** Mark a single node and all its descendants as 'running'. */
  markNodeRunning(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    if (node.type === 'test') {
      this._adjustSummary(node.status, -1);
      node.status = 'running';
      this._adjustSummary('running', +1);
    } else {
      node.status = 'running';
    }
    for (const childId of node.children) {
      this.markNodeRunning(childId);
    }
  }

  /** Mark all tests in a file as 'running'. */
  markFileRunning(filePath: string): void {
    const file = this.files.get(filePath);
    if (!file) {
      return;
    }
    file.status = 'running';
    for (const rootId of file.rootNodeIds) {
      this.markNodeRunning(rootId);
    }
  }

  /** Set all tests to 'running' — optionally scoped to a specific node subtree. */
  markTestsRunning(filePath: string, nodeId?: string): void {
    if (nodeId) {
      const file = this.files.get(filePath);
      if (file) {
        file.status = 'running';
      }
      this.markNodeRunning(nodeId);
      // Bubble up to mark ancestor suites as running
      const node = this.nodes.get(nodeId);
      if (node) {
        this._bubbleUpStatus(nodeId);
      }
    } else {
      this.markFileRunning(filePath);
    }
  }

  // ── Discovery population ──────────────────────────────────────────────────

  /**
   * Pre-populate a file entry from static discovery (before any run).
   * No-ops if the file is already present so live results are never overwritten.
   */
  fileDiscovered(fileId: string, filePath: string, name: string): void {
    if (this.files.has(fileId)) {
      return;
    }
    this.files.set(fileId, {
      fileId,
      filePath,
      name,
      status: 'pending',
      output: { lines: [], capturedAt: null },
      rootNodeIds: [],
    });
  }

  /**
   * Pre-populate a node entry from static discovery.
   * No-ops if the node is already present.
   */
  nodeDiscovered(
    fileId: string,
    nodeId: string,
    parentId: string | null,
    type: NodeType,
    name: string,
    fullName: string,
    line?: number,
  ): void {
    if (this.nodes.has(nodeId)) {
      return;
    }
    this.nodes.set(nodeId, {
      id: nodeId,
      type,
      name,
      fullName,
      fileId,
      parentId,
      children: [],
      status: 'pending',
      line,
      output: { lines: [], capturedAt: null },
      failureMessages: [],
    });
    // Register as child of parent or as root node of file
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent && !parent.children.includes(nodeId)) {
        parent.children.push(nodeId);
      }
    } else {
      const file = this.files.get(fileId);
      if (file && !file.rootNodeIds.includes(nodeId)) {
        file.rootNodeIds.push(nodeId);
      }
    }
    // Update summary counter
    if (type === 'test') {
      this._summary.total++;
    }
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  fileStarted(fileId: string, filePath: string, name: string): void {
    const existing = this.files.get(fileId);
    if (existing) {
      // File was pre-populated by static discovery — preserve the node tree
      // so the UI keeps showing it while the run is in progress.
      existing.status = 'running';
      existing.output = { lines: [], capturedAt: null };
      this.markFileRunning(filePath);
    } else {
      this.files.set(fileId, {
        fileId,
        filePath,
        name,
        status: 'running',
        output: { lines: [], capturedAt: null },
        rootNodeIds: [],
      });
    }
  }

  fileResult(fileId: string, status: TestStatus, duration?: number): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.status = status;
    file.duration = duration;
  }

  nodeStarted(
    fileId: string,
    nodeId: string,
    parentId: string | null,
    type: NodeType,
    name: string,
    fullName: string,
    line?: number,
  ): void {
    const existing = this.nodes.get(nodeId);
    if (existing) {
      // Node already exists from discovery or a previous run — update it
      if (existing.type === 'test') {
        this._adjustSummary(existing.status, -1);
      }
      existing.status = 'running';
      existing.name = name;
      existing.fullName = fullName;
      if (line != null) {
        existing.line = line;
      }
      existing.output = { lines: [], capturedAt: null };
      existing.failureMessages = [];
      if (existing.type === 'test') {
        this._adjustSummary('running', +1);
      }
      return;
    }
    // New node
    this.nodes.set(nodeId, {
      id: nodeId,
      type,
      name,
      fullName,
      fileId,
      parentId,
      children: [],
      status: 'running',
      line,
      output: { lines: [], capturedAt: null },
      failureMessages: [],
    });
    // Register as child of parent or as root node of file
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent && !parent.children.includes(nodeId)) {
        parent.children.push(nodeId);
      }
    } else {
      const file = this.files.get(fileId);
      if (file && !file.rootNodeIds.includes(nodeId)) {
        file.rootNodeIds.push(nodeId);
      }
    }
    if (type === 'test') {
      this._summary.total++;
      this._adjustSummary('running', +1);
    }
  }

  nodeResult(
    nodeId: string,
    status: TestStatus,
    duration?: number,
    failureMessages: string[] = [],
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (node.type === 'test') {
      this._adjustSummary(node.status, -1);
    }
    node.status = status;
    node.duration = duration;
    node.failureMessages = failureMessages;
    if (node.type === 'test') {
      this._adjustSummary(status, +1);
    }
  }

  /**
   * Bubble status up from a node through all ancestors to the file.
   * Called after setting test results to ensure parent suite statuses are correct.
   */
  bubbleUpStatus(nodeId: string): void {
    this._bubbleUpStatus(nodeId);
  }

  removePendingPlaceholders(fileId: string): void {
    // Collect node IDs to remove
    const toRemove: string[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (
        node.fileId === fileId &&
        node.type === 'test' &&
        (node.status === 'pending' || node.status === 'running') &&
        (node.name === '…' || node.name.includes('…') || node.name.includes('%'))
      ) {
        toRemove.push(nodeId);
      }
    }
    for (const nodeId of toRemove) {
      this._removeNode(nodeId);
    }
  }

  // ── Scoped output setters ──────────────────────────────────────────────────

  setFileOutput(fileId: string, output: ScopedOutput): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.output = output;
  }

  setNodeOutput(nodeId: string, output: ScopedOutput): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.output = output;
  }

  // ── Scoped output getters ──────────────────────────────────────────────────

  getFileOutput(fileId: string): ScopedOutput {
    return this.files.get(fileId)?.output ?? EMPTY_OUTPUT;
  }

  getNodeOutput(nodeId: string): ScopedOutput {
    return this.nodes.get(nodeId)?.output ?? EMPTY_OUTPUT;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getFile(fileId: string): FileResult | undefined {
    return this.files.get(fileId);
  }

  getNode(nodeId: string): TestNode | undefined {
    return this.nodes.get(nodeId);
  }

  getAllFiles(): FileResult[] {
    return Array.from(this.files.values());
  }

  /** Get all direct children nodes of a given node. */
  getChildren(nodeId: string): TestNode[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    return node.children
      .map((id) => this.nodes.get(id))
      .filter((n): n is TestNode => !!n);
  }

  /** Get all descendant test nodes (leaf nodes) under a given node. */
  getDescendantTests(nodeId: string): TestNode[] {
    const result: TestNode[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.type === 'test') {
        result.push(node);
      }
      for (const childId of node.children) {
        stack.push(childId);
      }
    }
    return result;
  }

  /** Get all nodes belonging to a file. */
  getFileNodes(fileId: string): TestNode[] {
    const result: TestNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.fileId === fileId) {
        result.push(node);
      }
    }
    return result;
  }

  getSummary(): {
    total: number;
    passed: number;
    failed: number;
    running: number;
    totalDuration: number;
  } {
    // Recompute totalDuration from files (cheap — file count is small)
    let totalDuration = 0;
    for (const file of this.files.values()) {
      totalDuration += file.duration ?? 0;
    }
    return { ...this._summary, totalDuration };
  }

  /**
   * Resets all file/node statuses back to 'pending' and clears outputs
   * and durations. Preserves the tree structure so the UI can show the
   * full tree immediately after reset.
   */
  resetToPending(): void {
    for (const file of this.files.values()) {
      file.status = 'pending';
      file.duration = undefined;
      file.output = { lines: [], capturedAt: null };
    }
    this._summary.passed = 0;
    this._summary.failed = 0;
    this._summary.running = 0;
    for (const node of this.nodes.values()) {
      node.status = 'pending';
      node.duration = undefined;
      node.output = { lines: [], capturedAt: null };
      node.failureMessages = [];
    }
  }

  /**
   * Serialises the full tree to a plain object safe to post to a webview.
   * Returns a recursive node tree under each file.
   */
  toJSON(): object {
    const files = Array.from(this.files.values()).map((f) =>
      this._serialiseFile(f),
    );
    return { files };
  }

  /**
   * Serialise a single file's full node tree for webview messaging.
   */
  serialiseFile(fileId: string): object | null {
    const file = this.files.get(fileId);
    if (!file) return null;
    return this._serialiseFile(file);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _serialiseFile(f: FileResult): object {
    return {
      fileId: f.fileId,
      filePath: f.filePath,
      name: f.name,
      status: f.status,
      duration: f.duration,
      rootNodeIds: f.rootNodeIds,
      nodes: this._serialiseNodes(f.fileId),
    };
  }

  /** Serialise all nodes for a given file as a flat array. */
  private _serialiseNodes(fileId: string): object[] {
    const result: object[] = [];
    for (const node of this.nodes.values()) {
      if (node.fileId !== fileId) continue;
      result.push({
        id: node.id,
        type: node.type,
        name: node.name,
        fullName: node.fullName,
        parentId: node.parentId,
        children: node.children,
        status: node.status,
        duration: node.duration,
        line: node.line,
        failureMessages: node.failureMessages,
        // output omitted — fetched on demand via scope-logs
      });
    }
    return result;
  }

  private _bubbleUpStatus(nodeId: string): void {
    let current = this.nodes.get(nodeId);
    while (current?.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;
      const childStatuses = parent.children.map(
        (id) => this.nodes.get(id)?.status ?? 'pending',
      );
      parent.status = childStatuses.includes('failed')
        ? 'failed'
        : childStatuses.includes('running')
          ? 'running'
          : childStatuses.every((s) => s === 'passed')
            ? 'passed'
            : childStatuses.every((s) => s === 'skipped')
              ? 'skipped'
              : 'pending';
      parent.duration = parent.children.reduce(
        (sum, id) => sum + (this.nodes.get(id)?.duration ?? 0),
        0,
      );
      current = parent;
    }
    // Update file status from root nodes
    if (current) {
      const file = this.files.get(current.fileId);
      if (file) {
        const rootStatuses = file.rootNodeIds.map(
          (id) => this.nodes.get(id)?.status ?? 'pending',
        );
        file.status = rootStatuses.includes('failed')
          ? 'failed'
          : rootStatuses.includes('running')
            ? 'running'
            : rootStatuses.every((s) => s === 'passed')
              ? 'passed'
              : 'pending';
        file.duration = file.rootNodeIds.reduce(
          (sum, id) => sum + (this.nodes.get(id)?.duration ?? 0),
          0,
        );
      }
    }
  }

  private _removeNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    // Remove from parent's children
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter((id) => id !== nodeId);
      }
    } else {
      const file = this.files.get(node.fileId);
      if (file) {
        file.rootNodeIds = file.rootNodeIds.filter((id) => id !== nodeId);
      }
    }

    // Recursively remove children
    for (const childId of [...node.children]) {
      this._removeNode(childId);
    }

    // Adjust summary
    if (node.type === 'test') {
      this._adjustSummary(node.status, -1);
      this._summary.total--;
    }

    this.nodes.delete(nodeId);
  }

  private _adjustSummary(status: TestStatus, delta: number): void {
    switch (status) {
      case 'passed':
        this._summary.passed += delta;
        break;
      case 'failed':
        this._summary.failed += delta;
        break;
      case 'running':
        this._summary.running += delta;
        break;
    }
  }
}
