/**
 * testListLayout.js — shared Test List Layout component.
 * Used in both explorer.html (sidebar) and results.html (panel col-1).
 *
 * Expects a global `vscode` postMessage API (acquired via acquireVsCodeApi()).
 * Exports a single `TestListLayout` class to be instantiated per container.
 *
 * Data model: each file has `rootNodeIds: string[]` and `nodes: Node[]`
 * where each node has `{ id, type, name, fullName, parentId, children, status, duration, line, failureMessages }`.
 * The `nodes` array is a flat pool; tree structure is defined by `parentId`/`children`.
 */

// durationLabel, durationClass, durationTooltip are globals injected by utils.js

function basename(p) {
  if (!p) return p;
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

const STATUS_ICON = {
  running: '<span class="status-running">⟳</span>',
  passed: '<span class="status-passed">✓</span>',
  failed: '<span class="status-failed">✗</span>',
  skipped: '<span class="status-skipped">—</span>',
  pending: '<span class="status-pending">○</span>',
  template: '<span class="status-template">⬚</span>',
};

/* TestListLayout ─────────────────────────────────────────────────────────── */
class TestListLayout {
  /**
   * @param {HTMLElement} container
   * @param {{ postMessage: (msg: object) => void }} vscodeApi
   * @param {{ showTimelineButton?: boolean }} [opts]
   */
  constructor(container, vscodeApi, opts) {
    this.container = container;
    this.vscode = vscodeApi;
    this._showTimelineButton = !!(opts && opts.showTimelineButton);
    this.data = []; // array of FileResult (plain objects, from toJSON())
    this.query = ''; // active search filter
    this.selectedId = null; // selected row key
    this.selectedFileId = null; // fileId of the selected row (any level)
    this.expanded = new Set(); // expanded file/suite/folder IDs
    this.failuresOnly = false;
    this.folderView = false;
    this._render();
  }

  // ── Helpers to build a nodeMap from a file's flat nodes array ─────────────

  /** Build an id→node lookup map from a file's nodes array. */
  _buildNodeMap(file) {
    const map = {};
    for (const node of (file.nodes ?? [])) {
      map[node.id] = node;
    }
    return map;
  }

  /** Replace the full data tree and re-render. */
  setData(files) {
    this.data = files;
    this._autoExpand(files);
    this._render();
  }

  /** Update a single file's data in-place and re-render. */
  updateFile(fileData) {
    const idx = this.data.findIndex((f) => f.fileId === fileData.fileId);
    if (idx >= 0) {
      this.data[idx] = fileData;
    } else {
      this.data.push(fileData);
    }
    // Auto-expand the file and its root nodes whenever it's updated
    this.expanded.add(fileData.fileId);
    const nodeMap = this._buildNodeMap(fileData);
    this._expandAllNodeIds(fileData, nodeMap);
    this._expandFolderPaths(fileData.name);

    // Targeted DOM update: only replace the wrapper for this one file instead
    // of re-rendering the entire list. Falls back to a full render when the
    // file isn't in the DOM yet or when folder-view is active.
    if (!this.folderView && !this.query && !this.failuresOnly) {
      const wrapper = this.container.querySelector(
        `[data-file-wrapper="${CSS.escape(fileData.fileId)}"]`,
      );
      if (wrapper) {
        const savedScroll = this.container.scrollTop;
        wrapper.innerHTML = this._renderFile(fileData);
        this._attachListenersIn(wrapper);
        this.container.scrollTop = savedScroll;
        return;
      }
    }
    this._render();
  }

  setQuery(q) {
    this.query = q.toLowerCase().trim();
    this._render();
  }

  setFailuresOnly(on) {
    this.failuresOnly = on;
    this._render();
  }

  setFolderView(on) {
    this.folderView = on;
    this._render();
  }

  collapseAll() {
    this.expanded.clear();
    this._render();
  }

  expandAll() {
    for (const file of this.data) {
      this.expanded.add(file.fileId);
      const nodeMap = this._buildNodeMap(file);
      this._expandAllNodeIds(file, nodeMap);
      this._expandFolderPaths(file.name);
    }
    this._render();
  }

  scrollToFirstFailure() {
    // Give the render a tick to flush, then scroll
    setTimeout(() => {
      const failedRow = Array.from(
        this.container.querySelectorAll('.test-row.level-file'),
      ).find((row) => row.querySelector('.status-failed'));
      if (failedRow)
        failedRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  /** Scroll the selected row into view (no-op if already visible). */
  scrollToSelected() {
    setTimeout(() => {
      const selected = this.container.querySelector('.test-row.selected');
      if (selected)
        selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  /** Mark a single file as running (partial rerun) without wiping other files. */
  markFileRunning(fileId, nodeId = null) {
    const file = this.data.find((f) => f.fileId === fileId);
    if (!file) {
      return;
    }
    file.status = 'running';
    const nodeMap = this._buildNodeMap(file);
    if (nodeId) {
      this._markNodeRunning(nodeMap, nodeId);
      
      // Also mark ancestors as running
      let curr = nodeMap[nodeId];
      while (curr && curr.parentId) {
        curr = nodeMap[curr.parentId];
        if (curr) curr.status = 'running';
      }
    } else {
      for (const rootId of (file.rootNodeIds ?? [])) {
        this._markNodeRunning(nodeMap, rootId);
      }
    }
    this._render();
  }

  _markNodeRunning(nodeMap, nodeId) {
    const node = nodeMap[nodeId];
    if (!node) return;
    node.status = 'running';
    for (const childId of (node.children ?? [])) {
      this._markNodeRunning(nodeMap, childId);
    }
  }

  setSelected(fileId, nodeId) {
    this.selectedId = nodeId ?? fileId ?? null;
    this.selectedFileId = fileId ?? null;
    this._render();
    this.scrollToSelected();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _autoExpand(files) {
    for (const file of files) {
      this.expanded.add(file.fileId);
      const nodeMap = this._buildNodeMap(file);
      this._expandAllNodeIds(file, nodeMap);
      this._expandFolderPaths(file.name);
    }
  }

  /** Expand all suite node IDs in a file's node tree. */
  _expandAllNodeIds(file, nodeMap) {
    for (const rootId of (file.rootNodeIds ?? [])) {
      this._expandNodeTree(nodeMap, rootId);
    }
  }

  _expandNodeTree(nodeMap, nodeId) {
    const node = nodeMap[nodeId];
    if (!node) return;
    if (node.type === 'suite') {
      this.expanded.add(node.id);
      for (const childId of (node.children ?? [])) {
        this._expandNodeTree(nodeMap, childId);
      }
    }
  }

  /** Add all ancestor folder path keys for a given relative file name. */
  _expandFolderPaths(name) {
    if (!name) return;
    const parts = name.replace(/\\/g, '/').split('/');
    let p = '';
    for (let i = 0; i < parts.length - 1; i++) {
      p = p ? `${p}/${parts[i]}` : parts[i];
      this.expanded.add(`folder:${p}`);
    }
  }

  _matches(name) {
    return !this.query || name.toLowerCase().includes(this.query);
  }

  _fileMatches(file) {
    if (this._matches(file.name)) return true;
    if (this._matches(basename(file.name))) return true;
    const nodeMap = this._buildNodeMap(file);
    for (const node of (file.nodes ?? [])) {
      if (this._matches(node.name)) return true;
    }
    return false;
  }

  /** Returns true if the node or any of its descendants match the current query. */
  _nodeMatchesQuery(nodeMap, nodeId) {
    const node = nodeMap[nodeId];
    if (!node) return false;
    if (this._matches(node.name)) return true;
    for (const childId of (node.children ?? [])) {
      if (this._nodeMatchesQuery(nodeMap, childId)) return true;
    }
    return false;
  }

  _render() {
    let filtered = this.query
      ? this.data.filter((f) => this._fileMatches(f))
      : this.data;
    if (this.failuresOnly)
      filtered = filtered.filter(
        (f) => f.status === 'failed' || f.status === 'running',
      );

    const savedScroll = this.container.scrollTop;

    // Use folder view only when not searching (search always shows flat list)
    if (this.folderView && !this.query) {
      const tree = this._buildFolderTree(filtered);
      this.container.innerHTML = this._renderFolderTree(tree);
    } else {
      this.container.innerHTML = filtered
        .map((f) => `<div data-file-wrapper="${esc(f.fileId)}">${this._renderFile(f)}</div>`)
        .join('');
    }
    this._attachListeners();

    this.container.scrollTop = savedScroll;
  }

  // ── Folder tree ──────────────────────────────────────────────────────────

  /**
   * Build a folder tree from a flat list of file results.
   * Each node: { name, path, children: Map<string, node>, files: FileResult[] }
   */
  _buildFolderTree(files) {
    const root = { name: '', path: '', children: new Map(), files: [] };
    for (const file of files) {
      const normalized = (file.name ?? '').replace(/\\/g, '/');
      const parts = normalized.split('/');
      const dirParts = parts.slice(0, -1);
      let node = root;
      let currentPath = '';
      for (const part of dirParts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, {
            name: part,
            path: currentPath,
            children: new Map(),
            files: [],
          });
        }
        node = node.children.get(part);
      }
      node.files.push(file);
    }
    return root;
  }

  _renderFolderTree(root) {
    // Render root-level files (tests with no directory) then subfolders
    const rootFiles = root.files.map((f) => this._renderFile(f)).join('');
    const subfolders = Array.from(root.children.values())
      .map((child) => this._renderFolderNode(child, 0))
      .join('');
    return rootFiles + subfolders;
  }

  _renderFolderNode(node, depth) {
    const folderId = `folder:${node.path}`;
    const isExpanded = this.expanded.has(folderId);
    const toggle = isExpanded
      ? '<span class="row-toggle expanded">▶</span>'
      : '<span class="row-toggle">▶</span>';
    const indentPx = 12 + depth * 16;
    const childIndentOffset = (depth + 1) * 16;

    const subfolders = Array.from(node.children.values())
      .map((child) => this._renderFolderNode(child, depth + 1))
      .join('');
    const files = node.files.map((f) => this._renderFile(f)).join('');

    return `
      <div class="test-row level-folder" data-id="${esc(folderId)}" data-scope="folder"
           data-folder-path="${esc(node.path)}" style="padding-left: ${indentPx}px">
        ${toggle}
        <span class="row-name">${esc(node.name)}</span>
        <button class="row-folder-collapse" title="Collapse folder" data-folder-path="${esc(node.path)}">⊟</button>
        <button class="row-folder-expand"   title="Expand folder"   data-folder-path="${esc(node.path)}">⊞</button>
      </div>
      <div class="children ${isExpanded ? 'expanded' : ''}" data-children="${esc(folderId)}"
           style="--indent-offset: ${childIndentOffset}px">
        ${subfolders}${files}
      </div>`;
  }

  // ── Row renderers ────────────────────────────────────────────────────────

  _renderFile(file) {
    const isExpanded = this.expanded.has(file.fileId) || !!this.query;
    const icon = STATUS_ICON[file.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(file.duration);
    const durClass = durationClass(file.duration, 'file');
    const durTip = durationTooltip(file.duration, 'file');
    const sel = this.selectedId === file.fileId ? 'selected' : '';
    const toggle = isExpanded
      ? '<span class="row-toggle expanded">▶</span>'
      : '<span class="row-toggle">▶</span>';
    const displayName = basename(file.name);

    const nodeMap = this._buildNodeMap(file);

    // Render root-level node children
    const rootNodeIds = file.rootNodeIds ?? [];
    let children = '';

    if (isExpanded || this.query) {
      children = rootNodeIds
        .map((rootId) => {
          const node = nodeMap[rootId];
          if (!node) return '';
          // (root) suite: render its children directly under the file
          if (node.type === 'suite' && node.name === '(root)') {
            return (node.children ?? [])
              .map((childId) => this._renderNode(file, nodeMap, nodeMap[childId], 1))
              .filter(Boolean)
              .join('');
          }
          return this._renderNode(file, nodeMap, node, 1);
        })
        .join('');
    }

    return `
      <div class="test-row level-file ${sel}"
           data-id="${esc(file.fileId)}" data-scope="file"
           data-file="${esc(file.fileId)}"
           style="padding-left: calc(12px + var(--indent-offset, 0px))">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name" title="${esc(displayName)}">${esc(displayName)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-collapse" title="Collapse" data-collapse-id="${esc(file.fileId)}">⊟</button>
        <button class="row-expand"   title="Expand"   data-expand-id="${esc(file.fileId)}">⊞</button>
        <button class="row-copy"  title="Copy file name"  data-copy-name="${esc(displayName)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun file"      data-rerun="file" data-file="${esc(file.fileId)}">▶</button>
      </div>
      <div class="children ${isExpanded ? 'expanded' : ''}" data-children="${esc(file.fileId)}">
        ${children}
      </div>`;
  }

  /**
   * Recursively render a node (suite or test) at a given depth level.
   * @param {object} file     - The parent file data
   * @param {object} nodeMap  - id→node lookup map
   * @param {object} node     - The current node to render
   * @param {number} depth    - Nesting depth (1 = direct child of file)
   */
  _renderNode(file, nodeMap, node, depth) {
    if (!node) return '';

    // Query filtering: skip nodes that don't match
    if (this.query && !this._nodeMatchesQuery(nodeMap, node.id)) {
      return '';
    }

    if (node.type === 'test') {
      return this._renderTestNode(file, node, depth);
    }
    return this._renderSuiteNode(file, nodeMap, node, depth);
  }

  _renderSuiteNode(file, nodeMap, node, depth) {
    const isExpanded = this.expanded.has(node.id) || !!this.query;
    const icon = STATUS_ICON[node.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(node.duration);
    const durCls = durationClass(node.duration, 'suite');
    const durTip = durationTooltip(node.duration, 'suite');
    const sel = this.selectedId === node.id ? 'selected' : '';
    const hasChildren = (node.children ?? []).length > 0;
    const toggle = hasChildren
      ? (isExpanded
        ? '<span class="row-toggle expanded">▶</span>'
        : '<span class="row-toggle">▶</span>')
      : '<span class="row-toggle"></span>';

    // Render children (both sub-suites and tests) only when expanded
    let children = '';
    if (isExpanded && hasChildren) {
      children = (node.children ?? [])
        .map((childId) => this._renderNode(file, nodeMap, nodeMap[childId], depth + 1))
        .filter(Boolean)
        .join('');
    }

    return `
      <div class="test-row level-suite ${sel}"
           data-id="${esc(node.id)}" data-scope="suite"
           data-file="${esc(file.fileId)}" data-node="${esc(node.id)}"
           data-dynamic-template="${!!node.isDynamicTemplate}"
           style="padding-left: calc(${12 + depth * 14}px + var(--indent-offset, 0px))">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name" title="${esc(node.name)}">${esc(node.name)}</span>
        ${dur ? `<span class="row-duration ${durCls}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-collapse" title="Collapse" data-collapse-id="${esc(node.id)}">⊟</button>
        <button class="row-expand"   title="Expand"   data-expand-id="${esc(node.id)}">⊞</button>
        <button class="row-copy"  title="Copy suite name" data-copy-name="${esc(node.name)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}"${node.line != null ? ` data-open-line="${node.line}"` : ''}>↗</button>
        <button class="row-rerun" title="Rerun suite"     data-rerun="suite"
                data-file="${esc(file.fileId)}" data-node="${esc(node.id)}"
                data-full-name="${esc(node.fullName)}">▶</button>
      </div>
      <div class="children ${isExpanded ? 'expanded' : ''}" data-children="${esc(node.id)}">
        ${children}
      </div>`;
  }

  _renderTestNode(file, node, depth) {
    const icon = STATUS_ICON[node.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(node.duration);
    const durCls = durationClass(node.duration, 'test');
    const durTip = durationTooltip(node.duration, 'test');
    const sel = this.selectedId === node.id ? 'selected' : '';

    return `
      <div class="test-row level-test ${sel}"
           data-id="${esc(node.id)}" data-scope="test"
           data-file="${esc(file.fileId)}" data-node="${esc(node.id)}"
           data-dynamic-template="${!!node.isDynamicTemplate}"
           style="padding-left: calc(${12 + depth * 14}px + var(--indent-offset, 0px))">
        <span class="row-toggle"></span>
        <span class="row-status">${icon}</span>
        <span class="row-name" title="${esc(node.name)}">${esc(node.name)}</span>
        ${dur ? `<span class="row-duration ${durCls}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-copy"  title="Copy test name"  data-copy-name="${esc(node.name)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}"${node.line != null ? ` data-open-line="${node.line}"` : ''}>↗</button>
        <button class="row-rerun" title="Rerun test"      data-rerun="test"
                data-file="${esc(file.fileId)}" data-node="${esc(node.id)}"
                data-full-name="${esc(node.fullName ?? node.name)}">▶</button>
        ${this._showTimelineButton ? `<button class="row-timeline row-timeline--disabled" title="Timeline Debugger — Coming Soon" disabled>⏱</button>` : ''}
      </div>`;
  }

  /** Attach listeners scoped to a specific subtree (e.g. a single file wrapper). */
  _attachListenersIn(root) {
    this._attachListeners(root);
  }

  _attachListeners(root) {
    const el = root ?? this.container;
    el.querySelectorAll('.test-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        // Ignore action button clicks — they have their own handlers
        if (
          e.target.closest('.row-rerun') ||
          e.target.closest('.row-open') ||
          e.target.closest('.row-copy') ||
          e.target.closest('.row-timeline') ||
          e.target.closest('.row-collapse') ||
          e.target.closest('.row-expand') ||
          e.target.closest('.row-folder-collapse') ||
          e.target.closest('.row-folder-expand')
        )
          return;

        const id = row.dataset.id;
        const rowScope = row.dataset.scope;
        const fileId = row.dataset.file;
        const nodeId = row.dataset.node;

        // Folder rows toggle on any click (whole row acts as toggle)
        if (rowScope === 'folder') {
          const childEl = this.container.querySelector(
            `[data-children="${CSS.escape(id)}"]`,
          );
          if (childEl) {
            const isNowExpanded = !childEl.classList.contains('expanded');
            childEl.classList.toggle('expanded', isNowExpanded);
            row
              .querySelector('.row-toggle')
              ?.classList.toggle('expanded', isNowExpanded);
            if (isNowExpanded) this.expanded.add(id);
            else this.expanded.delete(id);
          }
          return;
        }

        // For file/suite rows, toggle expand/collapse ONLY when the arrow is clicked
        if (rowScope !== 'test' && e.target.closest('.row-toggle')) {
          const childEl = this.container.querySelector(
            `[data-children="${CSS.escape(id)}"]`,
          );
          if (childEl) {
            const isNowExpanded = !childEl.classList.contains('expanded');
            childEl.classList.toggle('expanded', isNowExpanded);
            const toggle = row.querySelector('.row-toggle');
            if (toggle) toggle.classList.toggle('expanded', isNowExpanded);
            if (isNowExpanded) this.expanded.add(id);
            else this.expanded.delete(id);
          }
        }

        // Highlight selected row and notify extension
        this.container
          .querySelectorAll('.test-row')
          .forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        this.selectedId = id;
        this.selectedFileId = fileId;

        this.vscode.postMessage({
          type: 'select',
          scope: rowScope,
          fileId,
          nodeId,
        });
      });
    });

    el.querySelectorAll('.row-rerun').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const {
          rerun: rerunScope,
          file: fileId,
          node: nodeId,
          fullName,
        } = btn.dataset;
        this.vscode.postMessage({
          type: 'rerun',
          scope: rerunScope,
          fileId,
          nodeId,
          fullName,
        });
      });
    });

    el.querySelectorAll('.row-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const line =
          btn.dataset.openLine != null
            ? parseInt(btn.dataset.openLine, 10)
            : undefined;
        this.vscode.postMessage({
          type: 'open-file',
          filePath: btn.dataset.openPath,
          line,
        });
      });
    });

    el.querySelectorAll('.row-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.copyName;
        navigator.clipboard
          .writeText(name)
          .then(() => {
            const orig = btn.textContent;
            btn.textContent = '✓';
            btn.style.color = 'var(--vscode-charts-green, #4caf50)';
            setTimeout(() => {
              btn.textContent = orig;
              btn.style.color = '';
            }, 1000);
          })
          .catch(() => {});
      });
    });

    el.querySelectorAll('.row-timeline').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // TODO: re-enable when timeline debugger is ready
      });
    });

    el
      .querySelectorAll('.row-folder-collapse, .row-folder-expand')
      .forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const folderPath = btn.dataset.folderPath;
          const collapse = btn.classList.contains('row-folder-collapse');
          this._setFolderSubtreeExpanded(folderPath, !collapse);
          this._render();
        });
      });

    el.querySelectorAll('.row-collapse, .row-expand').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.collapseId ?? btn.dataset.expandId;
        const expand = btn.classList.contains('row-expand');
        const childEl = this.container.querySelector(`[data-children="${CSS.escape(id)}"]`);
        if (childEl) {
          childEl.classList.toggle('expanded', expand);
          const row = this.container.querySelector(`[data-id="${CSS.escape(id)}"]`);
          row?.querySelector('.row-toggle')?.classList.toggle('expanded', expand);
        }
        if (expand) this.expanded.add(id);
        else this.expanded.delete(id);
      });
    });
  }

  /** Expand or collapse all folder and file IDs within a given folder subtree. */
  _setFolderSubtreeExpanded(folderPath, expand) {
    const prefix = folderPath + '/';
    // All folder IDs at or below this path
    for (const id of [...this.expanded]) {
      if (id.startsWith('folder:' + folderPath)) {
        if (!expand) this.expanded.delete(id);
      }
    }
    if (expand) {
      // Re-add this folder and all descendant folder/file IDs
      this.expanded.add(`folder:${folderPath}`);
      for (const file of this.data) {
        const name = (file.name ?? '').replace(/\\/g, '/');
        if (name.startsWith(prefix)) {
          this.expanded.add(file.fileId);
          const nodeMap = this._buildNodeMap(file);
          this._expandAllNodeIds(file, nodeMap);
          this._expandFolderPaths(name);
        }
      }
    } else {
      // Collapse this folder and all descendants
      this.expanded.delete(`folder:${folderPath}`);
      for (const file of this.data) {
        const name = (file.name ?? '').replace(/\\/g, '/');
        if (name.startsWith(prefix)) {
          this.expanded.delete(file.fileId);
          const nodeMap = this._buildNodeMap(file);
          for (const node of (file.nodes ?? [])) {
            this.expanded.delete(node.id);
          }
        }
      }
      // Also remove any deeper folder IDs
      for (const id of [...this.expanded]) {
        if (id.startsWith(`folder:${prefix}`)) this.expanded.delete(id);
      }
    }
  }
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Export for use via <script> tag (no bundler)
window.TestListLayout = TestListLayout;
