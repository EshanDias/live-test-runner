/**
 * testListView.js — the normal test-explorer view for ExplorerView (explorer.html).
 *
 * Implements the router view contract: { mount(container, vscode, payload), unmount(), onMessage(msg) }
 *
 * Two panels (Tests / Coverage) are both always in the DOM; tab clicks toggle
 * CSS visibility so no state is lost on switch.
 */

(function () {
  // ── HTML template ───────────────────────────────────────────────────────────
  const TEMPLATE = `
<div class="explorer-layout">

  <!-- Nav tabs -->
  <div class="explorer-nav">
    <button class="explorer-nav-tab" data-active="true"  id="tabTests"   >Tests</button>
    <button class="explorer-nav-tab" data-active="false" id="tabCoverage">Coverage</button>
  </div>

  <!-- ══ TESTS PANEL ══════════════════════════════════════════════════════════ -->
  <div id="panelTests">

    <!-- Coverage summary (hidden until session starts) -->
    <div class="coverage-section hidden" id="coverageSection">
      <div class="coverage-header">
        <span class="coverage-title">Coverage</span>
        <span class="coverage-status" id="coverageStatus"></span>
      </div>
      <div class="coverage-table">
        <div class="cov-cell"><div class="label">Stmts</div><div class="value" id="covStmts">—</div></div>
        <div class="cov-cell"><div class="label">Branch</div><div class="value" id="covBranch">—</div></div>
        <div class="cov-cell"><div class="label">Fns</div><div class="value" id="covFns">—</div></div>
        <div class="cov-cell"><div class="label">Lines</div><div class="value" id="covLines">—</div></div>
      </div>
    </div>

    <!-- Action bar -->
    <div class="action-bar" id="actionBar">
      <button class="action-btn primary"              id="btnStart"   title="Discover and run all tests (Ctrl+Shift+T)">▶ Start Testing</button>
      <button class="action-btn secondary hidden"     id="btnRerun"   title="Stop current session and do a fresh run">↺ Rerun Tests</button>
      <button class="action-btn ghost hidden"         id="btnStop"    title="Stop the test session (Shift+Click to also clear cache)">⏹ Stop</button>
      <button class="action-btn ghost hidden"         id="btnStopRun" title="Stop the current run (Shift+Click to also clear cache)">⏹ Stop Testing</button>
      <span class="watch-indicator hidden" id="watchIndicator"
            title="Live Test Runner is active — tests will re-run automatically when you save a file">
        <span class="watch-dot"></span>live
      </span>
      <span class="watch-indicator tracing-indicator hidden" id="tracingIndicator"
            title="Collecting execution traces for smart on-save reruns">
        <span class="tracing-dot"></span><span class="tracing-label">tracing</span>
      </span>
    </div>

    <!-- Run progress -->
    <div class="run-progress" id="runProgress">Running — 0 / 0 files complete</div>

    <!-- Test summary table -->
    <div class="summary-section">
      <div class="summary-table">
        <div class="summary-cell total">
          <div class="label">Total</div>
          <div class="value" id="summaryTotal">—</div>
        </div>
        <div class="summary-cell passed">
          <div class="label">Passed</div>
          <div class="value" id="summaryPassed">—</div>
        </div>
        <div class="summary-cell failed">
          <div class="label">Failed</div>
          <div class="value" id="summaryFailed">—</div>
        </div>
      </div>
      <div class="summary-duration" id="summaryDuration"></div>
    </div>

    <!-- Search bar -->
    <div class="search-section">
      <input class="search-input" id="searchInput" type="text" placeholder="🔍 Search tests…" autocomplete="off">
      <button class="search-clear" id="searchClear" title="Clear search">✕</button>
    </div>

    <!-- List toolbar -->
    <div class="list-toolbar" id="listToolbar">
      <span class="list-toolbar-label" id="listCount"></span>
      <div class="list-toolbar-actions">
        <button class="toolbar-icon-btn" id="btnFailuresOnly" title="Show failures only" data-active="false">✗</button>
        <button class="toolbar-icon-btn" id="btnCollapseAll"  title="Collapse all">⊟</button>
        <button class="toolbar-icon-btn" id="btnExpandAll"    title="Expand all">⊞</button>
        <button class="toolbar-icon-btn" id="btnFolderView"   title="Toggle folder view" data-active="false">⊿</button>
      </div>
    </div>

    <!-- Empty state -->
    <div class="empty-state-panel hidden" id="emptyState">
      <div class="empty-state-icon">◎</div>
      <div class="empty-state-title">No tests discovered yet</div>
      <div class="empty-state-body">Click <strong>Start Testing</strong> to discover and run your test suite.</div>
    </div>

    <!-- Test list -->
    <div class="test-list" id="testList"></div>

  </div><!-- /panelTests -->

  <!-- ══ COVERAGE PANEL (hidden by default) ═══════════════════════════════════ -->
  <div id="panelCoverage" class="hidden cov-explorer-layout">

    <!-- Toolbar: title + metric toggle -->
    <div class="cov-panel-toolbar">
      <span class="cov-panel-title">Coverage</span>
      <div class="cov-metric-toggle">
        <button id="covTogglePct" data-active="true">%</button>
        <button id="covToggleNM"  data-active="false">N/M</button>
      </div>
    </div>

    <!-- Project totals -->
    <div class="cov-explorer-totals">
      <div class="cov-explorer-title">Project</div>
      <div class="coverage-table" style="margin-top:6px">
        <div class="cov-cell"><div class="label">Stmts</div><div class="value" id="covTotalStmts">—</div></div>
        <div class="cov-cell"><div class="label">Branch</div><div class="value" id="covTotalBranch">—</div></div>
        <div class="cov-cell"><div class="label">Fns</div><div class="value" id="covTotalFns">—</div></div>
        <div class="cov-cell"><div class="label">Lines</div><div class="value" id="covTotalLines">—</div></div>
      </div>
    </div>

    <!-- File table -->
    <div class="cov-file-table">
      <div class="cov-file-table-header" id="covTableHeader">
        <div data-col="file">File</div>
        <div data-col="statements"><span>Stmts</span><span class="cov-sort-icon" id="sortIconStatements"></span></div>
        <div data-col="branches"><span>Branch</span><span class="cov-sort-icon" id="sortIconBranches"></span></div>
        <div data-col="functions"><span>Fns</span><span class="cov-sort-icon" id="sortIconFunctions"></span></div>
        <div data-col="lines" title="Executable lines (excludes comments, blanks, type declarations)"><span>Lines</span><span class="cov-sort-icon" id="sortIconLines"></span></div>
      </div>
      <div id="covFileRows"></div>
      <div class="cov-explorer-empty hidden" id="covEmpty">
        No coverage data yet.<br>Start a test session to collect coverage.
      </div>
    </div>

  </div><!-- /panelCoverage -->

</div>`;

  // ── Module-level state (reset on each mount) ────────────────────────────────
  let _vscode           = null;
  let _list             = null;
  let _container        = null;

  let _totalFiles       = 0;
  let _completedFiles   = 0;
  let _failedDuringRun  = 0;
  let _runStartTime     = 0;
  let _isPartialRerun   = false;
  let _sessionState     = 'idle';   // 'idle' | 'discovering' | 'running' | 'watching'
  let _discoveryTotal   = 0;
  let _showFailuresOnly = false;
  let _showFolderView   = false;
  let _coverageThresholds = { red: 50, amber: 80 };
  let _activeTab        = 'tests'; // 'tests' | 'coverage'
  let _metricMode       = 'pct';   // 'pct' | 'nm'
  let _sortCol          = 'lines'; // 'statements'|'branches'|'functions'|'lines'
  let _sortAsc          = true;
  let _lastCovFiles     = [];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _q(id) {
    return _container ? _container.querySelector('#' + id) : null;
  }

  function _switchTab(tab) {
    _activeTab = tab;
    const testsPanel    = _q('panelTests');
    const covPanel      = _q('panelCoverage');
    const tabTests      = _q('tabTests');
    const tabCoverage   = _q('tabCoverage');
    if (!testsPanel || !covPanel) { return; }
    testsPanel.classList.toggle('hidden', tab !== 'tests');
    covPanel.classList.toggle('hidden',   tab !== 'coverage');
    tabTests.dataset.active    = String(tab === 'tests');
    tabCoverage.dataset.active = String(tab === 'coverage');
  }

  function applySessionState(state) {
    _sessionState = state;
    const btnStart       = _q('btnStart');
    const btnRerun       = _q('btnRerun');
    const btnStop        = _q('btnStop');
    const btnStopRun     = _q('btnStopRun');
    const watchIndicator = _q('watchIndicator');

    btnStart.classList.toggle('hidden',       state === 'running' || state === 'watching');
    btnRerun.classList.toggle('hidden',       state !== 'watching');
    btnStop.classList.toggle('hidden',        state !== 'watching');
    btnStopRun.classList.toggle('hidden',     state !== 'running');
    watchIndicator.classList.toggle('hidden', state !== 'watching');

    if (state === 'idle') {
      btnStart.disabled    = false;
      btnStart.textContent = '▶ Start Testing';
    } else if (state === 'discovering') {
      btnStart.disabled    = true;
      btnStart.textContent = `⟳ Discovering… 0 / ${_discoveryTotal}`;
    }
    _updateListCount();
  }

  function _applyDiscoveryProgress(discovered, total) {
    const btn = _q('btnStart');
    if (btn) { btn.textContent = `⟳ Discovering… ${discovered} / ${total}`; }
  }

  function updateSummary(total, passed, failed, durationMs) {
    const sTotal    = _q('summaryTotal');
    const sPassed   = _q('summaryPassed');
    const sFailed   = _q('summaryFailed');
    const sDuration = _q('summaryDuration');
    if (!sTotal) { return; }

    sTotal.textContent  = total  != null ? total  : '—';
    sPassed.textContent = passed != null ? passed : '—';
    sFailed.textContent = failed != null ? failed : '—';
    if (durationMs != null) {
      sDuration.textContent = `Last full run: ${durationLabel(durationMs)}`;
      sDuration.style.display = '';
    }
  }

  function _updateListCount() {
    const el          = _q('listCount');
    const emptyState  = _q('emptyState');
    const listToolbar = _q('listToolbar');
    if (!el || !_list) { return; }

    const total   = _list.data.length;
    const isEmpty = total === 0 && _sessionState === 'idle';
    if (emptyState)  { emptyState.classList.toggle('hidden', !isEmpty); }
    if (listToolbar) { listToolbar.classList.toggle('hidden', isEmpty); }
    el.textContent = total > 0 ? `${total} file${total !== 1 ? 's' : ''}` : '';
  }

  function _saveUiState(searchInput) {
    _vscode.setState({ query: searchInput.value, showFailuresOnly: _showFailuresOnly, showFolderView: _showFolderView });
  }

  // ── Coverage helpers ─────────────────────────────────────────────────────────

  function _covClass(pct, stale) {
    if (pct == null) { return 'cov-dash'; }
    if (stale)       { return 'cov-stale'; }
    if (pct < _coverageThresholds.red)   { return 'cov-red'; }
    if (pct < _coverageThresholds.amber) { return 'cov-amber'; }
    return 'cov-green';
  }

  function _metricText(metric) {
    if (!metric) { return '—'; }
    if (metric.total === 0) { return _metricMode === 'nm' ? '0/0' : '100%'; }
    if (_metricMode === 'nm') { return `${metric.covered}/${metric.total}`; }
    return metric.pct != null ? metric.pct + '%' : '—';
  }

  function _setCovCell(id, metric, stale) {
    const el = _q(id);
    if (!el) { return; }
    el.textContent = _metricText(metric);
    el.className   = 'value ' + _covClass(metric?.total === 0 ? 100 : metric?.pct, stale);
  }

  function _updateSortIcons() {
    ['statements','branches','functions','lines'].forEach((col) => {
      const el = _q('sortIcon' + col.charAt(0).toUpperCase() + col.slice(1));
      if (!el) { return; }
      if (col === _sortCol) {
        el.textContent = _sortAsc ? '▲' : '▼';
      } else {
        el.textContent = '';
      }
    });
  }

  function updateCoverage(totals, files) {
    _lastCovFiles = files ?? [];

    // ── compact badge in Tests panel ────────────────────────────────────────
    const sec = _q('coverageSection');
    if (sec) { sec.classList.remove('hidden'); }

    const st = _q('coverageStatus');
    if (!totals) {
      if (st) { st.textContent = ''; }
      ['covStmts','covBranch','covFns','covLines'].forEach((id) => {
        const el = _q(id); if (el) { el.textContent = '—'; el.className = 'value'; }
      });
    } else {
      if (st) { st.textContent = totals.scanComplete ? '' : 'Updating…'; }
      _setCovCell('covStmts',  totals.statements, false);
      _setCovCell('covBranch', totals.branches,   false);
      _setCovCell('covFns',    totals.functions,  false);
      _setCovCell('covLines',  totals.lines,      false);
    }

    // ── project totals row in Coverage panel ────────────────────────────────
    if (!totals) {
      ['covTotalStmts','covTotalBranch','covTotalFns','covTotalLines'].forEach((id) => {
        const el = _q(id); if (el) { el.textContent = '—'; el.className = 'value'; }
      });
    } else {
      _setCovCell('covTotalStmts',  totals.statements, false);
      _setCovCell('covTotalBranch', totals.branches,   false);
      _setCovCell('covTotalFns',    totals.functions,  false);
      _setCovCell('covTotalLines',  totals.lines,      false);
    }

    _renderCovFiles(_lastCovFiles);
  }

  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _basename(fp) { return fp.replace(/\\/g, '/').split('/').pop() ?? fp; }
  function _dirname(fp)  { const p = fp.replace(/\\/g, '/').split('/'); p.pop(); return p.join('/'); }

  function _renderCovFiles(files) {
    const rowsEl  = _q('covFileRows');
    const emptyEl = _q('covEmpty');
    if (!rowsEl) { return; }

    if (!files || files.length === 0) {
      rowsEl.innerHTML = '';
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }

    const sorted = files.slice().sort((a, b) => {
      const pa = a.pct?.[_sortCol]?.pct ?? (_sortAsc ? 101 : -1);
      const pb = b.pct?.[_sortCol]?.pct ?? (_sortAsc ? 101 : -1);
      return _sortAsc ? pa - pb : pb - pa;
    });

    rowsEl.innerHTML = sorted.map((f) => {
      const st = f.state === 'measured-stale';
      const p  = f.pct;
      const name = _basename(f.filePath);
      const dir  = _dirname(f.filePath);
      return `<div class="cov-file-row" data-path="${_esc(f.filePath)}" data-state="${_esc(f.state)}">
        <div class="cov-file-cell">
          <div class="cov-file-name" title="${_esc(f.filePath)}">${_esc(name)}</div>
          <div class="cov-file-dir"  title="${_esc(f.filePath)}">${_esc(dir)}</div>
        </div>
        <div class="cov-file-metric ${p?.statements?.total===0?'cov-na':_covClass(p?.statements?.pct,st)}">${_metricText(p?.statements)}</div>
        <div class="cov-file-metric ${p?.branches?.total===0?'cov-na':_covClass(p?.branches?.pct,st)}">${_metricText(p?.branches)}</div>
        <div class="cov-file-metric ${p?.functions?.total===0?'cov-na':_covClass(p?.functions?.pct,st)}">${_metricText(p?.functions)}</div>
        <div class="cov-file-metric ${p?.lines?.total===0?'cov-na':_covClass(p?.lines?.pct,st)}">${_metricText(p?.lines)}</div>
        <button class="cov-row-action" data-path="${_esc(f.filePath)}" title="Open file">↗</button>
      </div>`;
    }).join('');

    rowsEl.querySelectorAll('.cov-file-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('cov-row-action')) { return; }
        _vscode.postMessage({ type: 'open-file', filePath: row.dataset.path });
      });
    });
    rowsEl.querySelectorAll('.cov-row-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        _vscode.postMessage({ type: 'open-file', filePath: btn.dataset.path });
      });
    });

    _updateSortIcons();
  }

  // ── View object ─────────────────────────────────────────────────────────────

  const TestListView = {

    mount(container, vscode, payload) {
      _container        = container;
      _vscode           = vscode;
      _totalFiles       = 0;
      _completedFiles   = 0;
      _failedDuringRun  = 0;
      _runStartTime     = 0;
      _isPartialRerun   = false;
      _sessionState     = 'idle';
      _showFailuresOnly = false;
      _showFolderView   = false;
      _coverageThresholds = { red: 50, amber: 80 };
      _activeTab        = 'tests';
      _metricMode       = 'pct';
      _sortCol          = 'lines';
      _sortAsc          = true;
      _lastCovFiles     = [];

      container.innerHTML = TEMPLATE;

      _list = new TestListLayout(_q('testList'), vscode, { showTimelineButton: true });

      // ── Restore persisted UI state ──────────────────────────────────────────
      const searchInput     = _q('searchInput');
      const searchClear     = _q('searchClear');
      const btnFailuresOnly = _q('btnFailuresOnly');
      const btnFolderView   = _q('btnFolderView');

      const saved = vscode.getState();
      if (saved) {
        if (saved.query) {
          searchInput.value = saved.query;
          searchClear.classList.add('visible');
          _list.setQuery(saved.query);
        }
        if (saved.showFailuresOnly) {
          _showFailuresOnly = true;
          btnFailuresOnly.dataset.active = 'true';
          btnFailuresOnly.title = 'Show all tests';
          _list.setFailuresOnly(true);
        }
        if (saved.showFolderView) {
          _showFolderView = true;
          btnFolderView.dataset.active = 'true';
          btnFolderView.title = 'Switch to flat list';
          _list.setFolderView(true);
        }
      }

      // ── Nav tabs ────────────────────────────────────────────────────────────
      _q('tabTests').addEventListener('click',    () => _switchTab('tests'));
      _q('tabCoverage').addEventListener('click', () => _switchTab('coverage'));

      // ── Coverage panel controls ──────────────────────────────────────────
      _q('covTogglePct').addEventListener('click', () => {
        _metricMode = 'pct';
        _q('covTogglePct').dataset.active = 'true';
        _q('covToggleNM').dataset.active  = 'false';
        _renderCovFiles(_lastCovFiles);
      });
      _q('covToggleNM').addEventListener('click', () => {
        _metricMode = 'nm';
        _q('covTogglePct').dataset.active = 'false';
        _q('covToggleNM').dataset.active  = 'true';
        _renderCovFiles(_lastCovFiles);
      });

      _q('covTableHeader').addEventListener('click', (e) => {
        const col = e.target.closest('[data-col]')?.dataset.col;
        if (!col || col === 'file') { return; }
        if (_sortCol === col) { _sortAsc = !_sortAsc; }
        else { _sortCol = col; _sortAsc = true; }
        _renderCovFiles(_lastCovFiles);
      });

      // ── Search ──────────────────────────────────────────────────────────────
      searchInput.addEventListener('input', () => {
        const q = searchInput.value;
        searchClear.classList.toggle('visible', q.length > 0);
        _list.setQuery(q);
        _saveUiState(searchInput);
      });
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.remove('visible');
        _list.setQuery('');
        _saveUiState(searchInput);
      });

      // ── Action buttons ───────────────────────────────────────────────────────
      _q('btnStart').addEventListener('click', () => {
        _q('btnStart').disabled    = true;
        _q('btnStart').textContent = '⟳ Starting…';
        vscode.postMessage({ type: 'cmd', command: 'start' });
      });
      _q('btnRerun').addEventListener('click',   () => vscode.postMessage({ type: 'cmd', command: 'start' }));
      _q('btnStop').addEventListener('click',    (e) => vscode.postMessage({ type: 'cmd', command: e.shiftKey ? 'stopAndClearCache' : 'stop' }));
      _q('btnStopRun').addEventListener('click', (e) => vscode.postMessage({ type: 'cmd', command: e.shiftKey ? 'stopAndClearCache' : 'stop' }));

      // ── List toolbar ─────────────────────────────────────────────────────────
      _q('btnCollapseAll').addEventListener('click', () => _list.collapseAll());
      _q('btnExpandAll').addEventListener('click',   () => _list.expandAll());

      btnFailuresOnly.addEventListener('click', () => {
        _showFailuresOnly = !_showFailuresOnly;
        btnFailuresOnly.dataset.active = String(_showFailuresOnly);
        btnFailuresOnly.title = _showFailuresOnly ? 'Show all tests' : 'Show failures only';
        _list.setFailuresOnly(_showFailuresOnly);
        _saveUiState(searchInput);
      });

      btnFolderView.addEventListener('click', () => {
        _showFolderView = !_showFolderView;
        btnFolderView.dataset.active = String(_showFolderView);
        btnFolderView.title = _showFolderView ? 'Switch to flat list' : 'Toggle folder view';
        _list.setFolderView(_showFolderView);
        _saveUiState(searchInput);
      });

      // ── Restore from payload (e.g. returning from timeline mode) ─────────────
      if (payload && payload.thresholds)         { LiveTestUtils.setThresholds(payload.thresholds); }
      if (payload && payload.coverageThresholds) { _coverageThresholds = payload.coverageThresholds; }
      if (payload && payload.files) {
        _list.setData(payload.files);
        updateSummary(payload.total, payload.passed, payload.failed, null);
        _updateListCount();
        applySessionState(payload.sessionActive ? 'watching' : 'idle');
      }
      if (payload && payload.coverageTotals) {
        updateCoverage(payload.coverageTotals, payload.coverageFiles ?? []);
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
          if (msg.coverageThresholds) { _coverageThresholds = msg.coverageThresholds; }
          _list.setData(msg.files ?? []);
          updateSummary(msg.total, msg.passed, msg.failed, null);
          _updateListCount();
          if (msg.selection) { _list.setSelected(msg.selection.fileId, msg.selection.nodeId); }
          if (msg.isDiscovering) {
            _discoveryTotal = msg.discoveryTotal ?? 0;
            applySessionState('discovering');
            _applyDiscoveryProgress(msg.discoveryDone ?? 0, _discoveryTotal);
          } else {
            applySessionState(msg.sessionActive ? 'watching' : 'idle');
          }
          break;

        case 'session-started':
          applySessionState('watching');
          { const cs = _q('coverageSection'); if (cs) { cs.classList.remove('hidden'); } }
          break;

        case 'session-stopped':
          applySessionState('idle');
          { const cs = _q('coverageSection'); if (cs) { cs.classList.add('hidden'); } }
          ['covStmts','covBranch','covFns','covLines',
           'covTotalStmts','covTotalBranch','covTotalFns','covTotalLines'].forEach((id) => {
            const el = _q(id); if (el) { el.textContent = '—'; el.className = 'value'; }
          });
          _lastCovFiles = [];
          _renderCovFiles([]);
          break;

        case 'run-started':
          _totalFiles      = msg.fileCount ?? 0;
          _completedFiles  = 0;
          _failedDuringRun = 0;
          _runStartTime    = Date.now();
          _isPartialRerun  = false;
          _q('runProgress').textContent = `Running — 0 / ${_totalFiles} files`;
          _q('runProgress').classList.add('visible');
          applySessionState('running');
          updateSummary(null, null, null, null);
          _q('summaryDuration').style.display = 'none';
          if (msg.files) { _list.setData(msg.files); _updateListCount(); }
          break;

        case 'run-finished':
          _q('runProgress').classList.remove('visible');
          applySessionState(msg.sessionActive !== false ? 'watching' : 'idle');
          updateSummary(msg.total, msg.passed, msg.failed, msg.totalDuration);
          if (msg.failed > 0 && !_isPartialRerun) { _list.scrollToFirstFailure(); }
          _isPartialRerun = true;
          break;

        case 'files-rerunning':
          _isPartialRerun = true;
          _list.markFilesRunning(msg.fileIds, msg.nodeId);
          break;

        case 'file-started':
          _list.updateFile({ fileId: msg.fileId, filePath: msg.filePath, name: msg.name, status: 'running', suites: [] });
          _updateListCount();
          break;

        case 'full-file-result': {
          _completedFiles++;
          if (msg.file.status === 'failed') { _failedDuringRun++; }
          const elapsed1 = (Date.now() - _runStartTime).toFixed(1);
          const fl1 = _failedDuringRun > 0 ? ` • <span class="progress-failed">${_failedDuringRun} failed</span>` : '';
          _q('runProgress').innerHTML = `Running — ${_completedFiles} / ${_totalFiles} files • ${durationLabel(elapsed1)}${fl1}`;
          _list.updateFile(msg.file);
          updateSummary(msg.total, msg.passed, msg.failed, null);
          break;
        }

        case 'batch-file-results': {
          const batchFiles = msg.files ?? [];
          _completedFiles += batchFiles.length;
          for (const file of batchFiles) {
            if (file.status === 'failed') { _failedDuringRun++; }
            _list.updateFile(file);
          }
          const elapsed2 = (Date.now() - _runStartTime).toFixed(1);
          const fl2 = _failedDuringRun > 0 ? ` • <span class="progress-failed">${_failedDuringRun} failed</span>` : '';
          _q('runProgress').innerHTML = `Running — ${_completedFiles} / ${_totalFiles} files • ${durationLabel(elapsed2)}${fl2}`;
          updateSummary(msg.total, msg.passed, msg.failed, null);
          break;
        }

        case 'scope-changed':
          _list.setSelected(msg.fileId, msg.nodeId);
          break;

        case 'discovery-started':
          _discoveryTotal = msg.total;
          applySessionState('discovering');
          break;

        case 'discovery-progress':
          _applyDiscoveryProgress(msg.discovered, msg.fileTotal);
          if (msg.files && msg.files.length > 0) { _list.appendFiles(msg.files); _updateListCount(); }
          updateSummary(msg.total, msg.passed, msg.failed, null);
          break;

        case 'discovery-complete':
          applySessionState('idle');
          break;

        case 'discovery-file-removed':
          if (msg.fileId) { _list.removeFile(msg.fileId); _updateListCount(); }
          break;

        case 'source-scan-progress': {
          const sec = _q('coverageSection');
          const st  = _q('coverageStatus');
          if (sec) { sec.classList.remove('hidden'); }
          if (st)  { st.textContent = `Scanning ${msg.scanned}/${msg.total}`; }
          break;
        }

        case 'source-scan-done': {
          const st2 = _q('coverageStatus');
          if (st2) { st2.textContent = ''; }
          break;
        }

        case 'coverage-updated':
          updateCoverage(msg.totals, msg.files ?? []);
          break;

        case 'tracing-progress': {
          const watchEl   = _q('watchIndicator');
          const tracingEl = _q('tracingIndicator');
          if (!watchEl || !tracingEl) { break; }
          if (msg.done) {
            tracingEl.classList.add('hidden');
            if (_sessionState === 'watching') { watchEl.classList.remove('hidden'); }
          } else {
            watchEl.classList.add('hidden');
            tracingEl.querySelector('.tracing-label').textContent = `tracing ${msg.completed}/${msg.total}`;
            tracingEl.classList.remove('hidden');
          }
          break;
        }
      }
    },
  };

  window.TestListView = TestListView;
})();
