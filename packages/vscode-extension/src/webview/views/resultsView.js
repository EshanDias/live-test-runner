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
<div class="tracing-banner" id="tracingBanner" style="display:none">
  <span class="tracing-banner-dot"></span>
  <span id="tracingBannerText">Collecting traces…</span>
</div>
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

  function renderLogSections(sections) {
    const logContent = _q('logContent');
    if (!logContent) { return; }
    LogPanel.update(logContent, { sections });
    LogPanel.applyFilter(logContent, _activeTab);
    if (_autoScroll) { logContent.scrollTop = logContent.scrollHeight; }
  }

  function renderErrorSections(sections) {
    const errorContent = _q('errorContent');
    if (!errorContent) { return; }
    ErrorPanel.update(errorContent, { sections });
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

      _list = new TestListLayout(_q('testList'), vscode, { showTimelineButton: true });

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
          _activeTab = tab.dataset.tab;
          const logContent = _q('logContent');
          if (logContent) { LogPanel.applyFilter(logContent, _activeTab); }
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

      window.onUpdateSnapshot = (entry) => {
        _vscode.postMessage({
          type: 'update-snapshot',
          fileId: _list.selectedFileId,
          nodeId: _list.selectedNodeId
        });
      };
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
            _list.markFileRunning(fileId, msg.nodeId);
          }
          break;

        case 'discovery-progress':
          if (msg.file) { _list.updateFile(msg.file); updateListCount(); }
          break;

        case 'full-file-result':
          _list.updateFile(msg.file);
          updateListCount();
          break;

        case 'scope-changed':
          _list.setSelected(msg.fileId, msg.nodeId);
          break;

        case 'scope-logs':
          _autoScroll = true;
          renderLogSections(msg.payload.logSections);
          renderErrorSections(msg.payload.errorSections);
          break;

        case 'test-output':
          // Streaming output — not yet fully wired; no-op for now
          break;

        case 'tracing-progress': {
          const banner = _q('tracingBanner');
          const label  = _q('tracingBannerText');
          if (!banner || !label) { break; }
          if (msg.done) {
            banner.style.display = 'none';
          } else {
            label.textContent = `Collecting traces… ${msg.completed}/${msg.total}`;
            banner.style.display = 'flex';
          }
          break;
        }
      }
    },
  };

  window.ResultsView = ResultsView;
})();
