/**
 * testListView.js — the normal test-explorer view for ExplorerView (explorer.html).
 *
 * Implements the router view contract: { mount(container, vscode, payload), unmount(), onMessage(msg) }
 *
 * This module contains the full explorer layout (coverage gauge, action bar,
 * summary, search, test list) previously inlined in explorer.html.
 * Behaviour is identical to before.
 */

(function () {
  // ── HTML template ───────────────────────────────────────────────────────────
  const TEMPLATE = `
<div class="explorer-layout">

  <!-- Coverage gauge -->
  <div class="coverage-section">
    <div class="coverage-label">
      <span>Code Coverage</span>
      <span class="coming-soon" title="Coming in a future release">coming soon</span>
    </div>
    <div class="coverage-bar-track">
      <div class="coverage-bar-fill" id="coverageFill"></div>
    </div>
    <div class="coverage-explore-btn" title="Code coverage explorer — coming soon">
      Explore Coverage ›
    </div>
  </div>

  <!-- Action bar -->
  <div class="action-bar" id="actionBar">
    <button class="action-btn primary"              id="btnStart"    title="Discover and run all tests (Ctrl+Shift+T)">▶ Start Testing</button>
    <button class="action-btn secondary hidden"     id="btnRerun"    title="Stop current session and do a fresh run">↺ Rerun Tests</button>
    <button class="action-btn ghost hidden"         id="btnStop"     title="Stop the test session">⏹ Stop</button>
    <button class="action-btn ghost hidden"         id="btnStopRun"  title="Stop the current run">⏹ Stop Testing</button>
    <span   class="watch-indicator hidden"          id="watchIndicator"
            title="Live Test Runner is active — tests will re-run automatically when you save a file">
      <span class="watch-dot"></span>live
    </span>
    <span   class="watch-indicator tracing-indicator hidden" id="tracingIndicator"
            title="Collecting execution traces for smart on-save reruns">
      <span class="tracing-dot"></span><span class="tracing-label">tracing</span>
    </span>
  </div>

  <!-- Run progress -->
  <div class="run-progress" id="runProgress">Running — 0 / 0 files complete</div>

  <!-- Summary table -->
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

</div>`;

  // ── Module-level state (reset on each mount) ────────────────────────────────
  let _vscode       = null;
  let _list         = null;
  let _container    = null;

  let _totalFiles      = 0;
  let _completedFiles  = 0;
  let _failedDuringRun = 0;
  let _runStartTime    = 0;
  let _isPartialRerun  = false;
  let _sessionState    = 'idle';   // 'idle' | 'discovering' | 'running' | 'watching'
  let _discoveryTotal  = 0;
  let _showFailuresOnly = false;
  let _showFolderView   = false;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function _q(id) {
    return _container ? _container.querySelector('#' + id) : null;
  }

  function applySessionState(state) {
    _sessionState = state;
    const btnStart       = _q('btnStart');
    const btnRerun       = _q('btnRerun');
    const btnStop        = _q('btnStop');
    const btnStopRun     = _q('btnStopRun');
    const watchIndicator = _q('watchIndicator');

    // discovering reuses the Start button slot — all other buttons stay hidden
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
    // If durationMs is undefined (partial rerun), leave the label as-is
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

  // ── View object ─────────────────────────────────────────────────────────────

  const TestListView = {

    mount(container, vscode, payload) {
      _container       = container;
      _vscode          = vscode;
      _totalFiles      = 0;
      _completedFiles  = 0;
      _failedDuringRun = 0;
      _runStartTime    = 0;
      _isPartialRerun  = false;
      _sessionState    = 'idle';
      _showFailuresOnly = false;
      _showFolderView   = false;

      container.innerHTML = TEMPLATE;

      // TestListLayout with timeline button enabled for the explorer sidebar
      _list = new TestListLayout(_q('testList'), vscode, { showTimelineButton: true });

      // ── Restore persisted UI state ──────────────────────────────────────────
      const searchInput = _q('searchInput');
      const searchClear = _q('searchClear');
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
      _q('btnStop').addEventListener('click',    () => vscode.postMessage({ type: 'cmd', command: 'stop' }));
      _q('btnStopRun').addEventListener('click', () => vscode.postMessage({ type: 'cmd', command: 'stop' }));

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
      if (payload && payload.thresholds) {
        LiveTestUtils.setThresholds(payload.thresholds);
      }
      if (payload && payload.files) {
        _list.setData(payload.files);
        updateSummary(payload.total, payload.passed, payload.failed, null);
        _updateListCount();
        applySessionState(payload.sessionActive ? 'watching' : 'idle');
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
          updateSummary(msg.total, msg.passed, msg.failed, null);
          _updateListCount();
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
          break;

        case 'session-stopped':
          applySessionState('idle');
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
          // Reset to true so the next save-triggered rerun (which never sends
          // run-started) is treated as partial and won't scroll to first failure.
          _isPartialRerun = true;
          break;

        case 'files-rerunning':
          _isPartialRerun = true;
          for (const fileId of (msg.fileIds ?? [])) {
            _list.markFileRunning(fileId, msg.suiteId, msg.testId);
          }
          break;

        case 'file-started':
          _list.updateFile({
            fileId:   msg.fileId,
            filePath: msg.filePath,
            name:     msg.name,
            status:   'running',
            suites:   [],
          });
          _updateListCount();
          break;

        case 'full-file-result': {
          _completedFiles++;
          if (msg.file.status === 'failed') { _failedDuringRun++; }
          const el2 = ((Date.now() - _runStartTime)).toFixed(1);
          const fl2 = _failedDuringRun > 0
            ? ` • <span class="progress-failed">${_failedDuringRun} failed</span>`
            : '';
          _q('runProgress').innerHTML = `Running — ${_completedFiles} / ${_totalFiles} files • ${durationLabel(el2)}${fl2}`;
          _list.updateFile(msg.file);
          updateSummary(msg.total, msg.passed, msg.failed, null);
          break;
        }

        case 'scope-changed':
          _list.setSelected(msg.fileId, msg.suiteId, msg.testId);
          break;

        case 'discovery-started':
          _discoveryTotal = msg.total;
          applySessionState('discovering');
          break;

        case 'discovery-progress':
          _applyDiscoveryProgress(msg.discovered, msg.fileTotal);
          if (msg.file) { _list.updateFile(msg.file); _updateListCount(); }
          updateSummary(msg.total, msg.passed, msg.failed, null);
          break;

        case 'discovery-complete':
          applySessionState('idle');
          break;

        case 'coverage-update':
          const fill = _q('coverageFill');
          if (fill) { fill.style.width = `${msg.percent}%`; }
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
