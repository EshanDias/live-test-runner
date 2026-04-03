/**
 * testListLayout.js — shared Test List Layout component.
 * Used in both explorer.html (sidebar) and results.html (panel col-1).
 *
 * Expects a global `vscode` postMessage API (acquired via acquireVsCodeApi()).
 * Exports a single `TestListLayout` class to be instantiated per container.
 */

/* Duration thresholds ────────────────────────────────────────────────────── */
const THRESHOLDS = {
  test:  [100, 500],   // ms: [amber, red]
  suite: [500, 2000],
  file:  [1000, 5000],
};

function durationClass(ms, level) {
  if (ms == null) return '';
  const [amber, red] = THRESHOLDS[level] ?? THRESHOLDS.test;
  if (ms > red)   return 'slow';
  if (ms > amber) return 'moderate';
  return 'fast';
}

function durationTooltip(ms, level) {
  if (ms == null) return '';
  const [amber, red] = THRESHOLDS[level] ?? THRESHOLDS.test;
  if (ms > red)   return 'Slow — consider mocking heavy I/O';
  if (ms > amber) return 'Could be improved';
  return 'Fast';
}

function durationLabel(ms) {
  if (ms == null) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

const STATUS_ICON = {
  running: '<span class="status-running">⟳</span>',
  passed:  '<span class="status-passed">✓</span>',
  failed:  '<span class="status-failed">✗</span>',
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
    this.data = [];            // array of FileResult (plain objects, from toJSON())
    this.query = '';           // active search filter
    this.selectedId = null;   // selected row key
    this.selectedFileId = null; // fileId of the selected row (any level)
    this.expanded = new Set(); // expanded file/suite IDs
    this.failuresOnly = false;
    this._render();
  }

  /** Replace the full data tree and re-render. */
  setData(files) {
    this.data = files;
    // Auto-expand all files so suites and tests are visible by default
    for (const file of files) {
      this.expanded.add(file.fileId);
      for (const suite of (file.suites ?? [])) {
        this.expanded.add(suite.suiteId);
      }
    }
    this._render();
  }

  /** Update a single file's data in-place and re-render. */
  updateFile(fileData) {
    const idx = this.data.findIndex(f => f.fileId === fileData.fileId);
    if (idx >= 0) {
      this.data[idx] = fileData;
    } else {
      this.data.push(fileData);
    }
    // Auto-expand the file and its suites whenever it's updated
    this.expanded.add(fileData.fileId);
    for (const suite of (fileData.suites ?? [])) {
      this.expanded.add(suite.suiteId);
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

  collapseAll() {
    this.expanded.clear();
    this._render();
  }

  expandAll() {
    for (const file of this.data) {
      this.expanded.add(file.fileId);
      for (const suite of (file.suites ?? [])) {
        this.expanded.add(suite.suiteId);
      }
    }
    this._render();
  }

  scrollToFirstFailure() {
    // Give the render a tick to flush, then scroll
    setTimeout(() => {
      const failedRow = Array.from(this.container.querySelectorAll('.test-row.level-file'))
        .find(row => row.querySelector('.status-failed'));
      if (failedRow) failedRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  /** Mark a single file as running (partial rerun) without wiping other files. */
  markFileRunning(fileId) {
    const file = this.data.find(f => f.fileId === fileId);
    if (file) {
      file.status = 'running';
      this._render();
    }
  }

  setSelected(fileId, suiteId, testId) {
    this.selectedId = testId ?? suiteId ?? fileId ?? null;
    this.selectedFileId = fileId ?? null;
    this._render();
  }

  _matches(name) {
    return !this.query || name.toLowerCase().includes(this.query);
  }

  _fileMatches(file) {
    if (this._matches(file.name)) return true;
    for (const suite of file.suites) {
      if (this._matches(suite.name)) return true;
      for (const test of suite.tests) {
        if (this._matches(test.name)) return true;
      }
    }
    return false;
  }

  _render() {
    let filtered = this.query ? this.data.filter(f => this._fileMatches(f)) : this.data;
    if (this.failuresOnly) filtered = filtered.filter(f => f.status === 'failed' || f.status === 'running');

    this.container.innerHTML = filtered.map(f => this._renderFile(f)).join('');
    this._attachListeners();
  }

  _renderFile(file) {
    const isExpanded = this.expanded.has(file.fileId) || !!this.query;
    const icon = STATUS_ICON[file.status] ?? STATUS_ICON.pending;
    const dur = durationLabel(file.duration);
    const durClass = durationClass(file.duration, 'file');
    const durTip = durationTooltip(file.duration, 'file');
    const sel = this.selectedId === file.fileId ? 'selected' : '';
    const toggle = isExpanded ? '<span class="row-toggle expanded">▶</span>' : '<span class="row-toggle">▶</span>';

    // Suites named '(root)' are a synthetic wrapper for top-level tests written
    // without a describe() block — render their tests directly under the file.
    const children = file.suites.map(s =>
      s.name === '(root)'
        ? s.tests.map(t => this._renderTest(file, s, t)).join('')
        : this._renderSuite(file, s)
    ).join('');

    return `
      <div class="test-row level-file ${sel}"
           data-id="${esc(file.fileId)}" data-scope="file"
           data-file="${esc(file.fileId)}">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name" title="${esc(file.filePath)}">${esc(file.name)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-open" title="Open file" data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun file" data-rerun="file" data-file="${esc(file.fileId)}">▶</button>
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
    const toggle = suite.tests.length > 0
      ? (isExpanded ? '<span class="row-toggle expanded">▶</span>' : '<span class="row-toggle">▶</span>')
      : '<span class="row-toggle"></span>';

    const children = suite.tests.map(t => this._renderTest(file, suite, t)).join('');

    return `
      <div class="test-row level-suite ${sel}"
           data-id="${esc(suite.suiteId)}" data-scope="suite"
           data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}">
        ${toggle}
        <span class="row-status">${icon}</span>
        <span class="row-name">${esc(suite.name)}</span>
        ${dur ? `<span class="row-duration ${durClass}" title="${durTip}">${dur}</span>` : ''}
        <button class="row-open" title="Open file" data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun suite" data-rerun="suite"
                data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}">▶</button>
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
        <button class="row-open" title="Open file" data-open-path="${esc(file.filePath)}">↗</button>
        <button class="row-rerun" title="Rerun test" data-rerun="test"
                data-file="${esc(file.fileId)}" data-suite="${esc(suite.suiteId)}" data-test="${esc(test.testId)}"
                data-full-name="${esc(test.fullName ?? test.name)}">▶</button>
      </div>`;
  }

  _attachListeners() {
    this.container.querySelectorAll('.test-row').forEach(row => {
      row.addEventListener('click', (e) => {
        // Don't handle rerun/open button clicks here
        if (e.target.closest('.row-rerun') || e.target.closest('.row-open')) return;

        const id = row.dataset.id;
        const scope = row.dataset.scope;
        const fileId = row.dataset.file;
        const suiteId = row.dataset.suite;
        const testId = row.dataset.test;

        // Toggle expand for file/suite rows
        if (scope !== 'test') {
          const childEl = this.container.querySelector(`[data-children="${CSS.escape(id)}"]`);
          if (childEl) {
            const isNowExpanded = !childEl.classList.contains('expanded');
            childEl.classList.toggle('expanded', isNowExpanded);
            const toggle = row.querySelector('.row-toggle');
            if (toggle) toggle.classList.toggle('expanded', isNowExpanded);
            if (isNowExpanded) this.expanded.add(id);
            else this.expanded.delete(id);
          }
        }

        // Highlight selected row
        this.container.querySelectorAll('.test-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        this.selectedId = id;
        this.selectedFileId = fileId;

        this.vscode.postMessage({ type: 'select', scope, fileId, suiteId, testId });
      });
    });

    this.container.querySelectorAll('.row-rerun').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const { rerun: scope, file: fileId, suite: suiteId, test: testId, fullName } = btn.dataset;
        this.vscode.postMessage({ type: 'rerun', scope, fileId, suiteId, testId, fullName });
      });
    });

    this.container.querySelectorAll('.row-open').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.vscode.postMessage({ type: 'open-file', filePath: btn.dataset.openPath });
      });
    });
  }
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Export for use via <script> tag (no bundler)
window.TestListLayout = TestListLayout;
