/**
 * resultsView.js — the normal test-results view for ResultsView (results.html).
 *
 * Implements the router view contract: { mount(container, vscode, payload), unmount(), onMessage(msg) }
 *
 * This module contains the full three-column layout (test list | logs | errors)
 * that was previously inlined in results.html. Behaviour is identical to before.
 */

(function () {
  // ── HTML template ───────────────────────────────────────────────────────────
  const TEMPLATE = `
<div class="results-layout" id="layout">

  <!-- Column 1: Test List -->
  <div class="col-list" id="colList">
    <div class="col-header">Tests</div>
    <div class="search-section" style="padding: 4px 8px;">
      <input class="search-input" id="searchInput" type="text" placeholder="🔍 Filter…" autocomplete="off">
      <button class="search-clear" id="searchClear" title="Clear">✕</button>
    </div>
    <div class="list-toolbar" id="listToolbar" style="padding: 0 8px 4px;">
      <span class="list-toolbar-label" id="listCount"></span>
      <div class="list-toolbar-actions">
        <button class="toolbar-icon-btn" id="btnFailuresOnly" title="Show failures only" data-active="false">✗</button>
        <button class="toolbar-icon-btn" id="btnCollapseAll" title="Collapse all">⊟</button>
        <button class="toolbar-icon-btn" id="btnExpandAll" title="Expand all">⊞</button>
        <button class="toolbar-icon-btn" id="btnFolderView" title="Toggle folder view" data-active="false">⊿</button>
      </div>
    </div>
    <div class="test-list" id="testList" style="flex:1; overflow-y:auto;"></div>
  </div>

  <div class="resize-handle" id="resizeHandle1"></div>

  <!-- Column 2: Live Test Results output -->
  <div class="col-logs" id="colLogs">
    <div class="log-tabs">
      <div class="log-tab active" id="tabAll"   data-tab="all">All</div>
      <div class="log-tab"        id="tabLogs"  data-tab="log">Logs</div>
      <div class="log-tab"        id="tabInfo"  data-tab="info">Info</div>
      <div class="log-tab"        id="tabWarn"  data-tab="warn">Warn</div>
      <div class="log-tab"        id="tabError" data-tab="error">Error</div>
    </div>
    <div class="log-content" id="logContent">
      <div class="empty-state">Select a test to view output</div>
    </div>
  </div>

  <div class="resize-handle" id="resizeHandle2"></div>

  <!-- Column 3: Errors -->
  <div class="col-errors" id="colErrors">
    <div class="col-header">Errors</div>
    <div class="error-content" id="errorContent">
      <div class="empty-state">No errors</div>
    </div>
  </div>

</div>`;

  // ── Module-level state (reset on each mount) ────────────────────────────────
  let _vscode    = null;
  let _list      = null;
  let _container = null;
  let _activeTab       = 'all';
  let _autoScroll      = true;
  let _showFailuresOnly = false;
  let _showFolderView  = false;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _q(id) {
    return _container ? _container.querySelector('#' + id) : null;
  }

  function updateListCount() {
    const el = _q('listCount');
    if (!el || !_list) { return; }
    const total = _list.data.length;
    el.textContent = total > 0 ? `${total} file${total !== 1 ? 's' : ''}` : '';
  }

  function applyTabFilter(level) {
    _activeTab = level;
    const logContent = _q('logContent');
    if (!logContent) { return; }
    logContent.querySelectorAll('.log-line').forEach(el => {
      el.style.display = (level === 'all' || el.dataset.level === level) ? '' : 'none';
    });
    logContent.querySelectorAll('.output-section').forEach(section => {
      const hasVisible = [...section.querySelectorAll('.log-line')]
        .some(el => el.style.display !== 'none');
      section.style.display = hasVisible ? '' : 'none';
    });
  }

  function renderLogSections(sections) {
    const container = _q('logContent');
    if (!container) { return; }
    container.innerHTML = '';

    if (!sections || sections.length === 0) {
      container.innerHTML = '<div class="empty-state">Select a test to view output</div>';
      return;
    }

    const allEmpty = sections.every(s => s.lines.length === 0);
    if (allEmpty) {
      const scope = sections[0].scope;
      const msg = scope === 'test'
        ? 'No output captured at test level. Run the test individually to capture output here.'
        : scope === 'suite'
        ? 'No output captured at suite level. Check file level for console logs.'
        : 'No output captured yet. Run a test to see logs here.';
      container.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    for (const section of sections) {
      if (section.lines.length === 0) { continue; }

      const sectionEl = document.createElement('div');
      sectionEl.className = 'output-section';
      sectionEl.dataset.scope = section.scope;

      const header = document.createElement('div');
      header.className = 'section-header';
      header.innerHTML =
        `<span class="scope-icon">${_scopeIcon(section.scope)}</span>` +
        `<span class="scope-label">${_escHtml(section.label)}</span>` +
        `<span class="captured-at">${_formatCapturedAt(section.capturedAt)}</span>`;
      sectionEl.appendChild(header);

      const linesEl = document.createElement('div');
      linesEl.className = 'section-lines';
      for (const line of section.lines) {
        const lineEl = document.createElement('div');
        lineEl.className = `log-line log-line-${line.level}`;
        lineEl.dataset.level = line.level;
        lineEl.textContent = line.text;
        linesEl.appendChild(lineEl);
      }
      sectionEl.appendChild(linesEl);
      container.appendChild(sectionEl);
    }

    applyTabFilter(_activeTab);
    const logContent = _q('logContent');
    if (_autoScroll && logContent) { logContent.scrollTop = logContent.scrollHeight; }
  }

  function renderErrorSections(sections) {
    const container = _q('errorContent');
    if (!container) { return; }
    container.innerHTML = '';

    if (!sections || sections.length === 0 || sections.every(s => s.errors.length === 0)) {
      container.innerHTML = '<div class="empty-state no-errors">No failures for this selection ✓</div>';
      return;
    }

    for (const section of sections) {
      for (const entry of section.errors) {
        const entryEl = document.createElement('div');
        entryEl.className = 'error-entry';

        const nameEl = document.createElement('div');
        nameEl.className = 'error-test-name';
        nameEl.textContent = entry.testName;
        entryEl.appendChild(nameEl);

        for (const msg of entry.failureMessages) {
          const msgEl = document.createElement('pre');
          msgEl.className = 'error-message';
          msgEl.textContent = msg;
          entryEl.appendChild(msgEl);
        }

        container.appendChild(entryEl);
      }
    }
  }

  function _scopeIcon(scope) {
    return { file: '📄', suite: '🔷', test: '🔹' }[scope] ?? '•';
  }

  function _formatCapturedAt(capturedAt) {
    if (capturedAt === null) { return ''; }
    const diff = Date.now() - capturedAt;
    if (diff < 10_000)  { return 'just now'; }
    if (diff < 120_000) { return `${Math.floor(diff / 1000)}s ago`; }
    return new Date(capturedAt).toLocaleTimeString();
  }

  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _makeResizable(handle, leftEl) {
    let startX, startWidth;
    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startWidth = leftEl.offsetWidth;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    });
    function onMove(e) {
      const delta = e.clientX - startX;
      const newW  = Math.max(120, startWidth + delta);
      leftEl.style.width = newW + 'px';
      leftEl.style.flex  = 'none';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
    }
  }

  // ── View object ─────────────────────────────────────────────────────────────

  const ResultsView = {

    mount(container, vscode, payload) {
      _container        = container;
      _vscode           = vscode;
      _activeTab        = 'all';
      _autoScroll       = true;
      _showFailuresOnly = false;
      _showFolderView   = false;

      container.innerHTML = TEMPLATE;

      _list = new TestListLayout(_q('testList'), vscode);

      // ── List toolbar ────────────────────────────────────────────────────────
      const btnFailuresOnly = _q('btnFailuresOnly');
      const btnCollapseAll  = _q('btnCollapseAll');
      const btnExpandAll    = _q('btnExpandAll');
      const btnFolderView   = _q('btnFolderView');

      btnFailuresOnly.addEventListener('click', () => {
        _showFailuresOnly = !_showFailuresOnly;
        btnFailuresOnly.dataset.active = String(_showFailuresOnly);
        btnFailuresOnly.title = _showFailuresOnly ? 'Show all tests' : 'Show failures only';
        _list.setFailuresOnly(_showFailuresOnly);
      });
      btnCollapseAll.addEventListener('click', () => _list.collapseAll());
      btnExpandAll.addEventListener('click',   () => _list.expandAll());
      btnFolderView.addEventListener('click', () => {
        _showFolderView = !_showFolderView;
        btnFolderView.dataset.active = String(_showFolderView);
        btnFolderView.title = _showFolderView ? 'Switch to flat list' : 'Toggle folder view';
        _list.setFolderView(_showFolderView);
      });

      // ── Log tabs ────────────────────────────────────────────────────────────
      container.querySelectorAll('.log-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          container.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          applyTabFilter(tab.dataset.tab);
        });
      });

      // ── Search ──────────────────────────────────────────────────────────────
      const searchInput = _q('searchInput');
      const searchClear = _q('searchClear');
      searchInput.addEventListener('input', () => {
        const q = searchInput.value;
        searchClear.classList.toggle('visible', q.length > 0);
        _list.setQuery(q);
      });
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.remove('visible');
        _list.setQuery('');
      });

      // ── Column resize ────────────────────────────────────────────────────────
      _makeResizable(_q('resizeHandle1'), _q('colList'));
      _makeResizable(_q('resizeHandle2'), _q('colLogs'));

      // ── Auto-scroll lock ─────────────────────────────────────────────────────
      const logContent = _q('logContent');
      logContent.addEventListener('scroll', () => {
        const atBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 40;
        _autoScroll = atBottom;
      });

      // ── Restore from payload (e.g. returning from timeline mode) ─────────────
      if (payload && payload.thresholds) {
        LiveTestUtils.setThresholds(payload.thresholds);
      }
      if (payload && payload.files) {
        _list.setData(payload.files);
        updateListCount();
      }
    },

    unmount() {
      _list      = null;
      _container = null;
    },

    onMessage(msg) {
      switch (msg.type) {

        case 'init':
          LiveTestUtils.setThresholds(msg.thresholds);
          _list.setData(msg.files ?? []);
          updateListCount();
          break;

        case 'run-started':
          renderLogSections([]);
          renderErrorSections([]);
          if (msg.files) { _list.setData(msg.files); updateListCount(); }
          break;

        case 'files-rerunning':
          for (const fileId of (msg.fileIds ?? [])) {
            _list.markFileRunning(fileId, msg.suiteId, msg.testId);
          }
          break;

        case 'full-file-result':
          _list.updateFile(msg.file);
          updateListCount();
          break;

        case 'scope-changed':
          _list.setSelected(msg.fileId, msg.suiteId, msg.testId);
          break;

        case 'scope-logs':
          _autoScroll = true;
          renderLogSections(msg.payload.logSections);
          renderErrorSections(msg.payload.errorSections);
          break;

        case 'test-output':
          // Streaming output — not yet fully wired; no-op for now
          break;
      }
    },
  };

  window.ResultsView = ResultsView;
})();
