/**
 * testListLayout.js — shared Test List Layout component.
 * Used in both explorer.html (sidebar) and results.html (panel col-1).
 *
 * Expects a global `vscode` postMessage API (acquired via acquireVsCodeApi()).
 * Exports a single `TestListLayout` class to be instantiated per container.
 */

/* Duration thresholds ────────────────────────────────────────────────────── */
const THRESHOLDS = {
  test: [100, 500], // ms: [amber, red]
  suite: [500, 2000],
  file: [1000, 5000],
};

function durationClass(ms, level) {
  if (ms == null) return '';
  const [amber, red] = THRESHOLDS[level] ?? THRESHOLDS.test;
  if (ms > red) return 'slow';
  if (ms > amber) return 'moderate';
  return 'fast';
}

function durationTooltip(ms, level) {
  if (ms == null) return '';
  const [amber, red] = THRESHOLDS[level] ?? THRESHOLDS.test;
  if (ms > red) return 'Slow — consider mocking heavy I/O';
  if (ms > amber) return 'Could be improved';
  return 'Fast';
}

// humanTime.ts
function durationLabel(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;

  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);

  const seconds = sec % 60;
  const minutes = min % 60;
  const hours = hr;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

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
};

/* TestListLayout ─────────────────────────────────────────────────────────── */
class TestListLayout {
  /**
   * @param {HTMLElement} container
   * @param {{ postMessage: (msg: object) => void }} vscodeApi
   */
  constructor(container, vscodeApi) {
    this.container = container;
    this.vscode = vscodeApi;
    this.data = []; // array of FileResult (plain objects, from toJSON())
    this.query = ''; // active search filter
    this.selectedId = null; // selected row key
    this.selectedFileId = null; // fileId of the selected row (any level)
    this.expanded = new Set(); // expanded file/suite/folder IDs
    this.failuresOnly = false;
    this.folderView = false;
    this._render();
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
    // Auto-expand the file and its suites whenever it's updated
    this.expanded.add(fileData.fileId);
    for (const suite of fileData.suites ?? []) {
      this.expanded.add(suite.suiteId);
    }
    this._expandFolderPaths(fileData.name);
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
      for (const suite of file.suites ?? []) {
        this.expanded.add(suite.suiteId);
      }
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
      if (selected) selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  /** Mark a single file as running (partial rerun) without wiping other files. */
  markFileRunning(fileId, suiteId = null, testId = null) {
    const file = this.data.find((f) => f.fileId === fileId);
    if (file) {
      file.status = 'running';
      if (suiteId) {
        const suite = file.suites?.find((s) => s.suiteId === suiteId);
        if (suite) {
          suite.status = 'running';
          if (testId) {
            const test = suite.tests?.find((t) => t.testId === testId);
            if (test) test.status = 'running';
          }
        }
      }
      this._render();
    }
  }

  setSelected(fileId, suiteId, testId) {
    this.selectedId = testId ?? suiteId ?? fileId ?? null;
    this.selectedFileId = fileId ?? null;
    this._render();
    this.scrollToSelected();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _autoExpand(files) {
    for (const file of files) {
      this.expanded.add(file.fileId);
      for (const suite of file.suites ?? []) {
        this.expanded.add(suite.suiteId);
      }
      this._expandFolderPaths(file.name);
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
    for (const suite of file.suites) {
      if (this._matches(suite.name)) return true;
      for (const test of suite.tests) {
        if (this._matches(test.name)) return true;
      }
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

    // Use folder view only when not searching (search always shows flat list)
    if (this.folderView && !this.query) {
      const tree = this._buildFolderTree(filtered);
      this.container.innerHTML = this._renderFolderTree(tree);
    } else {
      this.container.innerHTML = filtered
        .map((f) => this._renderFile(f))
        .join('');
    }
    this._attachListeners();
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

    // Suites named '(root)' are a synthetic wrapper for top-level tests written
    // without a describe() block — render their tests directly under the file.
    const children = (file.suites ?? [])
      .map((s) =>
        s.name === '(root)'
          ? s.tests.map((t) => this._renderTest(file, s, t)).join('')
          : this._renderSuite(file, s),
      )
      .join('');

    return `
      <div class="test-row level-file ${sel}"
           data-id="${esc(file.fileId)}" data-scope="file"
           data-file="${esc(file.fileId)}">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name" title="${esc(file.name)}">${esc(displayName)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-copy"  title="Copy file name"  data-copy-name="${esc(displayName)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun file"      data-rerun="file" data-file="${esc(file.fileId)}">▶</button>
      </div>
      <div class="children ${isExpanded ? 'expanded' : ''}" data-children="${esc(file.fileId)}">
        ${children}
      </div>`;
  }

  _renderSuite(file, suite) {
    const isExpanded = this.expanded.has(suite.suiteId) || !!this.query;
    const icon = STATUS_ICON[suite.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(suite.duration);
    const durClass = durationClass(suite.duration, 'suite');
    const durTip = durationTooltip(suite.duration, 'suite');
    const sel = this.selectedId === suite.suiteId ? 'selected' : '';
    const toggle =
      suite.tests.length > 0
        ? isExpanded
          ? '<span class="row-toggle expanded">▶</span>'
          : '<span class="row-toggle">▶</span>'
        : '<span class="row-toggle"></span>';

    const children = suite.tests
      .map((t) => this._renderTest(file, suite, t))
      .join('');

    return `
      <div class="test-row level-suite ${sel}"
           data-id="${esc(suite.suiteId)}" data-scope="suite"
           data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name">${esc(suite.name)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-copy"  title="Copy suite name" data-copy-name="${esc(suite.name)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun suite"     data-rerun="suite"
                data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}"
                data-full-name="${esc(suite.name)}">▶</button>
      </div>
      <div class="children ${isExpanded ? 'expanded' : ''}" data-children="${esc(suite.suiteId)}">
        ${children}
      </div>`;
  }

  _renderTest(file, suite, test) {
    const icon = STATUS_ICON[test.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(test.duration);
    const durClass = durationClass(test.duration, 'test');
    const durTip = durationTooltip(test.duration, 'test');
    const sel = this.selectedId === test.testId ? 'selected' : '';

    return `
      <div class="test-row level-test ${sel}"
           data-id="${esc(test.testId)}" data-scope="test"
           data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}" data-test="${esc(test.testId)}">
        <span class="row-toggle"></span>
        <span class="row-status">${icon}</span>
        <span class="row-name">${esc(test.name)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-copy"  title="Copy test name"  data-copy-name="${esc(test.name)}">⎘</button>
        <button class="row-open"  title="Open file"       data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun test"      data-rerun="test"
                data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}" data-test="${esc(test.testId)}"
                data-full-name="${esc(test.fullName ?? test.name)}">▶</button>
      </div>`;
  }

  _attachListeners() {
    this.container.querySelectorAll('.test-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        // Ignore action button clicks — they have their own handlers
        if (
          e.target.closest('.row-rerun') ||
          e.target.closest('.row-open') ||
          e.target.closest('.row-copy') ||
          e.target.closest('.row-folder-collapse') ||
          e.target.closest('.row-folder-expand')
        ) return;

        const id = row.dataset.id;
        const scope = row.dataset.scope;
        const fileId = row.dataset.file;
        const suiteId = row.dataset.suite;
        const testId = row.dataset.test;

        // Folder rows toggle on any click (whole row acts as toggle)
        if (scope === 'folder') {
          const childEl = this.container.querySelector(`[data-children="${CSS.escape(id)}"]`);
          if (childEl) {
            const isNowExpanded = !childEl.classList.contains('expanded');
            childEl.classList.toggle('expanded', isNowExpanded);
            row.querySelector('.row-toggle')?.classList.toggle('expanded', isNowExpanded);
            if (isNowExpanded) this.expanded.add(id);
            else this.expanded.delete(id);
          }
          return;
        }

        // For file/suite rows, toggle expand/collapse ONLY when the arrow is clicked
        if (scope !== 'test' && e.target.closest('.row-toggle')) {
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

        this.vscode.postMessage({ type: 'select', scope, fileId, suiteId, testId });
      });
    });

    this.container.querySelectorAll('.row-rerun').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const { rerun: scope, file: fileId, suite: suiteId, test: testId, fullName } = btn.dataset;
        this.vscode.postMessage({ type: 'rerun', scope, fileId, suiteId, testId, fullName });
      });
    });

    this.container.querySelectorAll('.row-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.vscode.postMessage({ type: 'open-file', filePath: btn.dataset.openPath });
      });
    });

    this.container.querySelectorAll('.row-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.copyName;
        navigator.clipboard.writeText(name).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓';
          btn.style.color = 'var(--vscode-charts-green, #4caf50)';
          setTimeout(() => {
            btn.textContent = orig;
            btn.style.color = '';
          }, 1000);
        }).catch(() => {});
      });
    });

    this.container.querySelectorAll('.row-folder-collapse, .row-folder-expand').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const folderPath = btn.dataset.folderPath;
        const collapse = btn.classList.contains('row-folder-collapse');
        this._setFolderSubtreeExpanded(folderPath, !collapse);
        this._render();
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
          for (const suite of file.suites ?? []) this.expanded.add(suite.suiteId);
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
          for (const suite of file.suites ?? []) this.expanded.delete(suite.suiteId);
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
