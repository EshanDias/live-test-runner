/**
 * timelineView.js — timeline debugger view for ResultsView (results.html).
 *
 * Layout: [timeline bar 75%] | [Console/Errors tabs 25%]
 *
 * Task 11: timeline bar + playback controls.
 * Task 14: log/error panels wired in (right column).
 */

(function () {
  // ── Module-level state ────────────────────────────────────────────────────────

  let _vscode = null;
  let _container = null;
  let _engine = null;
  let _store = null;
  let _errorStepIds = new Set();
  let _activeTab = 'console'; // 'console' | 'errors'

  // Containers for LogPanel / ErrorPanel (set after render)
  let _logContainer = null;
  let _errContainer = null;

  // ── Public view interface ─────────────────────────────────────────────────────

  const TimelineView = {
    mount(container, vscode, payload) {
      _container = container;
      _vscode = vscode;
      _engine = null;
      _store = null;
      _errorStepIds = new Set();
      _logContainer = null;
      _errContainer = null;
      _activeTab = 'console';

      _renderLoading(payload && payload.testFullName);
    },

    unmount() {
      if (_engine) { _engine.pause(); }
      // Notify extension host so it can clear editor decorations.
      if (_vscode) { _vscode.postMessage({ type: 'timeline-exited' }); }
      _engine = null;
      _store = null;
      _container = null;
      _vscode = null;
      _logContainer = null;
      _errContainer = null;
    },

    onMessage(msg) {
      if (msg.type === 'timeline-loading') {
        if (_engine) { _engine.pause(); }
        _engine = null;
        _store = null;
        _renderLoading();
        return;
      }
      if (msg.type === 'timeline-ready') {
        _store = msg.store;
        _buildErrorSet();
        _renderTimeline();
        return;
      }
      if (msg.type === 'timeline-error') {
        _renderError(msg.message);
        return;
      }
    },
  };

  // ── Loading / error states ─────────────────────────────────────────────────────

  function _renderLoading(testName) {
    if (!_container) return;
    const label = testName ? `Running trace: ${testName}` : 'Running instrumented trace…';
    _container.innerHTML = `
      <div class="tl-loading">
        <div class="tl-spinner"></div>
        <p>${_esc(label)}</p>
      </div>`;
    _injectStyles();
  }

  function _renderError(message) {
    if (!_container) return;
    _container.innerHTML = `
      <div class="tl-loading">
        <p style="color:var(--vscode-errorForeground)">Timeline error: ${_esc(message)}</p>
      </div>`;
  }

  // ── Main timeline render ───────────────────────────────────────────────────────

  function _renderTimeline() {
    if (!_container || !_store) return;

    _injectStyles();

    const steps = _store.steps || [];

    _container.innerHTML = `
      <div class="tl-root">
        <!-- Left: timeline (75%) -->
        <div class="tl-main">
          <div class="tl-context-label" id="tl-context"></div>
          <div class="tl-bar-wrap">
            <div class="tl-bar" id="tl-bar"></div>
          </div>
          <div class="tl-controls">
            <button class="tl-btn" id="tl-first"  title="First step">⏮</button>
            <button class="tl-btn" id="tl-prev"   title="Step back">◀</button>
            <button class="tl-btn" id="tl-play"   title="Play">▶</button>
            <button class="tl-btn" id="tl-next"   title="Step forward">▶|</button>
            <button class="tl-btn" id="tl-last"   title="Last step">⏭</button>
            <button class="tl-btn" id="tl-pause"  title="Pause">⏸</button>
          </div>
          <div class="tl-step-count" id="tl-step-count"></div>
        </div>

        <!-- Right: console + errors (25%) -->
        <div class="tl-side">
          <div class="tl-tabs">
            <button class="tl-tab tl-tab--active" id="tab-console" data-tab="console">Console</button>
            <button class="tl-tab" id="tab-errors" data-tab="errors">Errors</button>
          </div>
          <div class="tl-tab-body" id="tl-log-container"></div>
          <div class="tl-tab-body" id="tl-err-container" style="display:none"></div>
        </div>
      </div>`;

    _logContainer = _container.querySelector('#tl-log-container');
    _errContainer = _container.querySelector('#tl-err-container');

    // Render static errors panel immediately
    _renderErrorPanel();

    // Wire tabs
    _container.querySelectorAll('.tl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        _container.querySelectorAll('.tl-tab').forEach(b => b.classList.remove('tl-tab--active'));
        btn.classList.add('tl-tab--active');
        _logContainer.style.display = _activeTab === 'console' ? '' : 'none';
        _errContainer.style.display = _activeTab === 'errors'  ? '' : 'none';
      });
    });

    if (steps.length === 0) {
      _container.querySelector('#tl-context').textContent = 'No steps recorded.';
      _updateLogPanel(null);
      return;
    }

    _engine = new PlaybackEngine(_store);
    _buildBar(steps);
    _bindControls();
    _applyStep(_engine.currentStep);
  }

  // ── Timeline bar ───────────────────────────────────────────────────────────────

  function _buildBar(steps) {
    const bar = _container.querySelector('#tl-bar');
    if (!bar) return;

    bar.innerHTML = '';
    for (const step of steps) {
      const box = document.createElement('div');
      box.className = 'tl-box';
      box.dataset.stepId = String(step.stepId);
      if (_errorStepIds.has(step.stepId)) { box.classList.add('tl-box--error'); }
      box.title = `${_basename(step.file)} · line ${step.line}`;
      box.addEventListener('click', () => {
        _engine.jumpTo(step.stepId);
        _applyStep(_engine.currentStep);
      });
      bar.appendChild(box);
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────────────

  function _bindControls() {
    const $ = (id) => _container.querySelector('#' + id);

    $('tl-first').addEventListener('click', () => { _applyStep(_engine.jumpToFirst()); });
    $('tl-prev').addEventListener('click',  () => { _applyStep(_engine.prev()); });
    $('tl-next').addEventListener('click',  () => { _applyStep(_engine.next()); });
    $('tl-last').addEventListener('click',  () => { _applyStep(_engine.jumpToLast()); });

    $('tl-play').addEventListener('click', () => {
      if (_engine.isPlaying()) return;
      _engine.play((step) => _applyStep(step));
      _updatePlayPause(true);
    });

    $('tl-pause').addEventListener('click', () => {
      _engine.pause();
      _updatePlayPause(false);
    });
  }

  function _updatePlayPause(playing) {
    if (!_container) return;
    const play  = _container.querySelector('#tl-play');
    const pause = _container.querySelector('#tl-pause');
    if (!play || !pause) return;
    play.disabled  = playing;
    pause.disabled = !playing;
  }

  // ── Step application ───────────────────────────────────────────────────────────

  function _applyStep(step) {
    if (!step || !_container) return;

    if (!_engine.isPlaying()) { _updatePlayPause(false); }

    // Context label
    const ctx = _container.querySelector('#tl-context');
    if (ctx) {
      const file = _basename(step.file);
      const fn   = step.functionName ? ` · ${step.functionName}` : '';
      ctx.textContent = `${file}${fn} · line ${step.line}`;
    }

    // Step counter
    const counter = _container.querySelector('#tl-step-count');
    if (counter) {
      counter.textContent = `Step ${_engine.currentStepId} of ${_engine.stepCount}`;
    }

    // Active box in bar
    const bar = _container.querySelector('#tl-bar');
    if (bar) {
      bar.querySelectorAll('.tl-box--active').forEach(el => el.classList.remove('tl-box--active'));
      const active = bar.querySelector(`[data-step-id="${step.stepId}"]`);
      if (active) {
        active.classList.add('tl-box--active');
        active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
    }

    // Update console panel (cumulative logs up to current step)
    _updateLogPanel(step.stepId);

    // Notify extension host (editor highlight + sidebar state update)
    if (_vscode) {
      _vscode.postMessage({ type: 'step-changed', stepId: step.stepId, filePath: step.file, line: step.line });
    }
  }

  // ── Log / Error panels ─────────────────────────────────────────────────────────

  function _updateLogPanel(currentStepId) {
    if (!_logContainer || !window.LogPanel) return;

    if (!_store || currentStepId === null) {
      LogPanel.update(_logContainer, { sections: [] });
      return;
    }

    // Collect all logs from steps up to and including currentStepId.
    const lines = [];
    for (const step of (_store.steps || [])) {
      const stepLogs = _store.logs[step.stepId] || [];
      for (const entry of stepLogs) {
        lines.push({
          level: entry.level,
          text: `step ${step.stepId} · ${entry.text}`,
        });
      }
      if (step.stepId === currentStepId) { break; }
    }

    const sections = lines.length > 0
      ? [{ scope: 'test', label: _store.testFullName || 'Test', capturedAt: null, lines }]
      : [];

    LogPanel.update(_logContainer, { sections });
  }

  function _renderErrorPanel() {
    if (!_errContainer || !window.ErrorPanel) return;

    const errors = _store && _store.errors ? _store.errors : [];
    const sections = errors.length > 0
      ? [{ errors: errors.map(e => ({ testName: e.testName || _store.testFullName || 'Test', failureMessages: e.failureMessages })) }]
      : [];

    ErrorPanel.mount(_errContainer, { sections });
  }

  // ── Utility ────────────────────────────────────────────────────────────────────

  function _buildErrorSet() {
    _errorStepIds = new Set();
    if (!_store || !_store.errors) return;
    for (const e of _store.errors) { _errorStepIds.add(e.stepId); }
  }

  function _basename(filePath) {
    if (!filePath) return '';
    return filePath.split(/[\\/]/).pop() || filePath;
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _injectStyles() {
    if (document.getElementById('tl-styles')) return;
    const style = document.createElement('style');
    style.id = 'tl-styles';
    style.textContent = `
      .tl-loading {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; height: 100%; gap: 12px;
        color: var(--vscode-foreground); font-size: 13px; opacity: 0.8;
      }
      .tl-spinner {
        width: 24px; height: 24px;
        border: 3px solid var(--vscode-focusBorder);
        border-top-color: transparent;
        border-radius: 50%;
        animation: tl-spin 0.8s linear infinite;
      }
      @keyframes tl-spin { to { transform: rotate(360deg); } }

      .tl-root {
        display: flex; height: 100%; overflow: hidden;
      }
      .tl-main {
        display: flex; flex-direction: column; flex: 3;
        padding: 8px 12px; box-sizing: border-box; gap: 6px;
        border-right: 1px solid var(--vscode-panel-border, #3c3c3c);
        overflow: hidden;
      }
      .tl-side {
        display: flex; flex-direction: column; flex: 1;
        min-width: 120px; overflow: hidden;
      }

      .tl-context-label {
        font-size: 11px; opacity: 0.75; flex-shrink: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-height: 16px;
      }
      .tl-bar-wrap {
        flex: 1; overflow-x: auto; overflow-y: hidden;
        display: flex; align-items: center;
      }
      .tl-bar {
        display: flex; gap: 3px; align-items: center;
        min-width: max-content; padding: 4px 0;
      }
      .tl-box {
        width: 14px; height: 22px; flex-shrink: 0;
        border-radius: 3px; cursor: pointer;
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        border: 1px solid transparent;
        transition: background 0.1s, border-color 0.1s;
      }
      .tl-box:hover { border-color: var(--vscode-focusBorder); }
      .tl-box--active {
        background: var(--vscode-button-background, #0e639c);
        border-color: var(--vscode-button-background, #0e639c);
      }
      .tl-box--error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
      .tl-box--error.tl-box--active { background: var(--vscode-errorForeground, #f48771); }

      .tl-controls {
        display: flex; justify-content: center; gap: 6px; flex-shrink: 0;
      }
      .tl-btn {
        background: none; border: 1px solid var(--vscode-button-secondaryBackground, #3c3c3c);
        color: var(--vscode-foreground); border-radius: 4px;
        padding: 3px 8px; cursor: pointer; font-size: 13px; min-width: 28px;
      }
      .tl-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #444); }
      .tl-btn:disabled { opacity: 0.4; cursor: default; }

      .tl-step-count {
        font-size: 10px; opacity: 0.55; text-align: center; flex-shrink: 0;
      }

      /* Side panel tabs */
      .tl-tabs {
        display: flex; flex-shrink: 0;
        border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      }
      .tl-tab {
        flex: 1; padding: 4px; font-size: 11px;
        background: none; border: none; color: var(--vscode-foreground);
        cursor: pointer; opacity: 0.6; border-bottom: 2px solid transparent;
      }
      .tl-tab:hover { opacity: 0.9; }
      .tl-tab--active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }

      .tl-tab-body {
        flex: 1; overflow-y: auto; font-size: 11px;
        padding: 4px 6px; box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  }

  window.TimelineView = TimelineView;
})();
