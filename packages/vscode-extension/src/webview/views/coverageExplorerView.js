/**
 * coverageExplorerView.js — Coverage Explorer page for ExplorerView (explorer.html).
 *
 * Implements the router view contract: { mount(container, vscode, payload), unmount(), onMessage(msg) }
 *
 * Shows project-level totals (4-col table) and a file-by-file breakdown.
 * Click a file row → opens the file in the editor.
 * "Tests" tab → routes back to testList.
 */

(function () {
  const TEMPLATE = `
<div class="cov-explorer-layout">

  <!-- Nav tabs -->
  <div class="explorer-nav">
    <button class="explorer-nav-tab" data-active="false" id="covTabTests"   >Tests</button>
    <button class="explorer-nav-tab" data-active="true"  id="covTabCoverage">Coverage</button>
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
  <div class="cov-file-table" id="covFileTable">
    <div class="cov-file-table-header">
      <div>File</div>
      <div style="text-align:right">Stmts</div>
      <div style="text-align:right">Branch</div>
      <div style="text-align:right">Fns</div>
      <div style="text-align:right">Lines</div>
    </div>
    <div id="covFileRows"></div>
    <div class="cov-explorer-empty hidden" id="covEmpty">
      No coverage data yet.<br>Start a test session to collect coverage.
    </div>
  </div>

</div>`;

  let _container = null;
  let _vscode    = null;
  let _thresholds = { red: 50, amber: 80 };
  let _lastTotals = null;
  let _lastFiles  = [];

  function _q(id) {
    return _container ? _container.querySelector('#' + id) : null;
  }

  function _covClass(pct, stale) {
    if (pct == null)  { return 'cov-dash'; }
    if (stale)        { return 'cov-stale'; }
    if (pct < _thresholds.red)   { return 'cov-red'; }
    if (pct < _thresholds.amber) { return 'cov-amber'; }
    return 'cov-green';
  }

  function _pctText(pct) {
    return pct != null ? pct + '%' : '—';
  }

  function _setCovCell(id, pct, stale) {
    const el = _q(id);
    if (!el) { return; }
    el.textContent = _pctText(pct);
    el.className   = 'value ' + _covClass(pct, stale);
  }

  function _renderTotals(totals) {
    if (!totals || !totals.scanComplete) {
      ['covTotalStmts','covTotalBranch','covTotalFns','covTotalLines'].forEach((id) => {
        const el = _q(id); if (el) { el.textContent = totals ? 'Updating…' : '—'; el.className = 'value'; }
      });
      return;
    }
    _setCovCell('covTotalStmts',  totals.statements.pct, false);
    _setCovCell('covTotalBranch', totals.branches.pct,   false);
    _setCovCell('covTotalFns',    totals.functions.pct,  false);
    _setCovCell('covTotalLines',  totals.lines.pct,      false);
  }

  function _basename(filePath) {
    return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  }

  function _dirname(filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/');
  }

  function _renderFiles(files) {
    const rowsEl = _q('covFileRows');
    const emptyEl = _q('covEmpty');
    if (!rowsEl) { return; }

    if (!files || files.length === 0) {
      rowsEl.innerHTML = '';
      if (emptyEl) { emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) { emptyEl.classList.add('hidden'); }

    // Sort by lines pct ascending (worst first)
    const sorted = files.slice().sort((a, b) => {
      const pa = a.pct?.lines?.pct ?? 101;
      const pb = b.pct?.lines?.pct ?? 101;
      return pa - pb;
    });

    rowsEl.innerHTML = sorted.map((f) => {
      const stale = f.state === 'measured-stale';
      const p = f.pct;
      const stmts  = _covClass(p?.statements?.pct, stale);
      const branch = _covClass(p?.branches?.pct,   stale);
      const fns    = _covClass(p?.functions?.pct,  stale);
      const lines  = _covClass(p?.lines?.pct,      stale);
      const name   = _basename(f.filePath);
      const dir    = _dirname(f.filePath);
      return `<div class="cov-file-row" data-path="${_esc(f.filePath)}">
        <div>
          <div class="cov-file-name" title="${_esc(f.filePath)}">${_esc(name)}</div>
          <div class="cov-file-dir">${_esc(dir)}</div>
        </div>
        <div class="cov-file-metric ${stmts}">${_pctText(p?.statements?.pct)}</div>
        <div class="cov-file-metric ${branch}">${_pctText(p?.branches?.pct)}</div>
        <div class="cov-file-metric ${fns}">${_pctText(p?.functions?.pct)}</div>
        <div class="cov-file-metric ${lines}">${_pctText(p?.lines?.pct)}</div>
      </div>`;
    }).join('');

    // Click → open file
    rowsEl.querySelectorAll('.cov-file-row').forEach((row) => {
      row.addEventListener('click', () => {
        _vscode.postMessage({ type: 'open-file', filePath: row.dataset.path });
      });
    });
  }

  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const CoverageExplorerView = {

    mount(container, vscode, payload) {
      _container  = container;
      _vscode     = vscode;
      _thresholds = { red: 50, amber: 80 };
      _lastTotals = null;
      _lastFiles  = [];

      container.innerHTML = TEMPLATE;

      if (payload && payload.coverageThresholds) { _thresholds = payload.coverageThresholds; }
      if (payload && payload.coverageTotals)     { _lastTotals = payload.coverageTotals; }
      if (payload && payload.coverageFiles)      { _lastFiles  = payload.coverageFiles; }

      _renderTotals(_lastTotals);
      _renderFiles(_lastFiles);

      _q('covTabTests').addEventListener('click', () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'route', view: 'testList' } }));
      });
    },

    unmount() {
      _container = null;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'init':
          if (msg.coverageThresholds) { _thresholds = msg.coverageThresholds; }
          if (msg.coverageTotals !== undefined) { _lastTotals = msg.coverageTotals; }
          if (msg.coverageFiles  !== undefined) { _lastFiles  = msg.coverageFiles ?? []; }
          _renderTotals(_lastTotals);
          _renderFiles(_lastFiles);
          break;

        case 'coverage-updated':
          _lastTotals = msg.totals;
          _lastFiles  = msg.files ?? [];
          _renderTotals(_lastTotals);
          _renderFiles(_lastFiles);
          break;

        case 'session-stopped':
          _lastTotals = null;
          _lastFiles  = [];
          _renderTotals(null);
          _renderFiles([]);
          break;
      }
    },
  };

  window.CoverageExplorerView = CoverageExplorerView;
})();
