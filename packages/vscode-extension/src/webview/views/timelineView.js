/**
 * timelineView.js — timeline debugger view for ResultsView (results.html).
 *
 * Layout: [timeline bar 75%] | [Console/Errors tabs 25%]
 *
 * Task 11: timeline bar + playback controls.
 * Task 14: log/error panels wired in (right column).
 * Task 16: drag scrubbing + mouse-wheel zoom.
 * Task 17: loop compression (consecutive same-line runs → ×N box).
 */

(function () {
  // ── Module-level state ────────────────────────────────────────────────────────

  let _vscode = null;
  let _container = null;
  let _engine = null;
  let _store = null;
  let _errorStepIds = new Set();
  let _activeTab = 'console'; // 'console' | 'errors'

  // Zoom level: 'line' | 'function' | 'file'
  let _zoom = 'line';
  // Compressed bar items (set by _buildBarItems)
  let _barItems = []; // [{ type: 'step'|'loop', step?, steps?, count?, firstStepId, lastStepId }]

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

  // ── Bar items: loop compression + zoom grouping ────────────────────────────────

  const LOOP_THRESHOLD = 10;

  /**
   * Compress consecutive steps at the same line (loops) into single items,
   * then group by zoom level.
   */
  function _buildBarItems(steps) {
    // 1. Loop compression: detect runs of the same line
    const compressed = [];
    let i = 0;
    while (i < steps.length) {
      const s = steps[i];
      let j = i + 1;
      while (j < steps.length && steps[j].line === s.line && steps[j].file === s.file) { j++; }
      const count = j - i;
      if (count > LOOP_THRESHOLD) {
        compressed.push({ type: 'loop', steps: steps.slice(i, j), count,
          firstStepId: steps[i].stepId, lastStepId: steps[j - 1].stepId,
          file: s.file, line: s.line });
      } else {
        for (let k = i; k < j; k++) {
          compressed.push({ type: 'step', step: steps[k],
            firstStepId: steps[k].stepId, lastStepId: steps[k].stepId });
        }
      }
      i = j;
    }

    if (_zoom === 'line') { return compressed; }

    // 2. Function or file zoom: group consecutive items with same key
    const keyFn = _zoom === 'function'
      ? (item) => `${item.file || item.step?.file}::${item.step?.functionName || item.file || ''}`
      : (item) => item.file || item.step?.file || '';

    const grouped = [];
    let g = null;
    for (const item of compressed) {
      const key = keyFn(item);
      if (!g || g.key !== key) {
        g = { type: 'group', key, items: [item],
          firstStepId: item.firstStepId, lastStepId: item.lastStepId,
          label: _zoom === 'function' ? (item.step?.functionName || _basename(item.step?.file || item.file || '')) : _basename(item.step?.file || item.file || '') };
        grouped.push(g);
      } else {
        g.items.push(item);
        g.lastStepId = item.lastStepId;
      }
    }
    return grouped;
  }

  // ── Timeline bar ───────────────────────────────────────────────────────────────

  function _buildBar(steps) {
    const bar = _container.querySelector('#tl-bar');
    if (!bar) return;

    _barItems = _buildBarItems(steps);
    bar.innerHTML = '';

    for (const item of _barItems) {
      const box = document.createElement('div');

      if (item.type === 'step') {
        box.className = 'tl-box';
        box.dataset.firstStepId = String(item.firstStepId);
        box.dataset.lastStepId  = String(item.lastStepId);
        if (_errorStepIds.has(item.step.stepId)) { box.classList.add('tl-box--error'); }
        box.title = `${_basename(item.step.file)} · line ${item.step.line}`;
      } else if (item.type === 'loop') {
        box.className = 'tl-box tl-box--loop';
        box.dataset.firstStepId = String(item.firstStepId);
        box.dataset.lastStepId  = String(item.lastStepId);
        box.title = `Loop ×${item.count} at line ${item.line}`;
        box.textContent = `×${item.count}`;
      } else {
        // group (zoom out)
        box.className = 'tl-box tl-box--group';
        box.dataset.firstStepId = String(item.firstStepId);
        box.dataset.lastStepId  = String(item.lastStepId);
        box.title = item.label;
        box.textContent = item.label;
      }

      box.addEventListener('click', () => {
        _engine.jumpTo(item.lastStepId);
        _applyStep(_engine.currentStep);
      });
      bar.appendChild(box);
    }

    // Mouse-wheel zoom
    bar.addEventListener('wheel', _onWheel, { passive: true });

    // Drag scrubbing
    _bindDrag(bar);
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────────

  const ZOOM_LEVELS = ['file', 'function', 'line'];

  function _onWheel(e) {
    if (!_store || !_store.steps) return;
    const idx = ZOOM_LEVELS.indexOf(_zoom);
    if (e.deltaY < 0 && idx < ZOOM_LEVELS.length - 1) {
      _zoom = ZOOM_LEVELS[idx + 1]; // zoom in
    } else if (e.deltaY > 0 && idx > 0) {
      _zoom = ZOOM_LEVELS[idx - 1]; // zoom out
    } else { return; }
    _buildBar(_store.steps);
    _highlightActiveBox(_engine.currentStepId);
  }

  function _highlightActiveBox(stepId) {
    const bar = _container && _container.querySelector('#tl-bar');
    if (!bar) return;
    bar.querySelectorAll('.tl-box--active').forEach(el => el.classList.remove('tl-box--active'));
    // Find a box whose range contains the stepId
    const boxes = bar.querySelectorAll('[data-first-step-id]');
    for (const box of boxes) {
      const first = parseInt(box.dataset.firstStepId, 10);
      const last  = parseInt(box.dataset.lastStepId, 10);
      if (stepId >= first && stepId <= last) {
        box.classList.add('tl-box--active');
        box.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
        break;
      }
    }
  }

  // ── Drag scrubbing ─────────────────────────────────────────────────────────────

  const DRAG_SLOW_THROTTLE = 80; // ms

  function _bindDrag(bar) {
    let dragging = false;
    let lastThrottleTime = 0;
    let pendingStep = null;

    const getStepFromEvent = (e) => {
      const x = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
      const boxes = bar.querySelectorAll('[data-first-step-id]');
      let closestBox = null;
      let closestDist = Infinity;
      for (const box of boxes) {
        const rect = box.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const dist = Math.abs(x - cx);
        if (dist < closestDist) { closestDist = dist; closestBox = box; }
      }
      return closestBox ? parseInt(closestBox.dataset.lastStepId, 10) : null;
    };

    const startDrag = (e) => {
      dragging = true;
      lastThrottleTime = 0;
      e.preventDefault();
    };

    const moveDrag = (e) => {
      if (!dragging) return;
      const stepId = getStepFromEvent(e);
      if (stepId === null) return;
      pendingStep = stepId;

      const now = Date.now();
      if (now - lastThrottleTime >= DRAG_SLOW_THROTTLE) {
        lastThrottleTime = now;
        // Slow drag: update context label and highlight box (not full step-changed)
        _engine.jumpTo(stepId);
        const step = _engine.currentStep;
        if (step) {
          const ctx = _container && _container.querySelector('#tl-context');
          if (ctx) {
            const file = _basename(step.file);
            const fn   = step.functionName ? ` · ${step.functionName}` : '';
            ctx.textContent = `${file}${fn} · line ${step.line}`;
          }
          _highlightActiveBox(step.stepId);
        }
      }
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      // Release: full commit
      if (pendingStep !== null) {
        _engine.jumpTo(pendingStep);
        _applyStep(_engine.currentStep);
        pendingStep = null;
      }
    };

    bar.addEventListener('mousedown',  startDrag);
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('mouseup',   endDrag);

    bar.addEventListener('touchstart', startDrag, { passive: false });
    bar.addEventListener('touchmove',  moveDrag,  { passive: true });
    bar.addEventListener('touchend',   endDrag);
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

    // Active box in bar (works with grouped/compressed items via range check)
    _highlightActiveBox(step.stepId);

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
      .tl-box--loop {
        width: auto; min-width: 28px; padding: 0 4px;
        font-size: 9px; display: flex; align-items: center; justify-content: center;
        background: repeating-linear-gradient(
          45deg,
          var(--vscode-button-secondaryBackground, #3c3c3c) 0px,
          var(--vscode-button-secondaryBackground, #3c3c3c) 4px,
          transparent 4px, transparent 8px
        );
        border: 1px solid var(--vscode-focusBorder, #007fd4);
      }
      .tl-box--group {
        width: auto; min-width: 40px; max-width: 80px; padding: 0 4px;
        font-size: 9px; display: flex; align-items: center; justify-content: center;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

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
