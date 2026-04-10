/**
 * timelineView.js — timeline debugger view for ResultsView (results.html).
 *
 * Layout: [timeline scrub track + controls 75%] | [Console/Errors tabs 25%]
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

  /** Horizontal translate (px) of #tl-bar for center-playhead layout */
  let _railTranslateX = 0;
  let _railResizeObserver = null;
  let _dragAbort = null;

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
      if (_engine) {
        _engine.pause();
      }
      if (_railResizeObserver) {
        _railResizeObserver.disconnect();
        _railResizeObserver = null;
      }
      if (_dragAbort) {
        _dragAbort.abort();
        _dragAbort = null;
      }
      _engine = null;
      _store = null;
      _container = null;
      _vscode = null;
      _logContainer = null;
      _errContainer = null;
      _railTranslateX = 0;
    },

    onMessage(msg) {
      if (msg.type === 'timeline-loading') {
        if (_engine) {
          _engine.pause();
        }
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
    const title = 'Running instrumented trace';
    const detail = testName
      ? _esc(testName)
      : 'Preparing Jest instrumentation and collecting steps…';
    _container.innerHTML = `
      <div class="tl-loading" role="status" aria-live="polite">
        <div class="tl-loading-card">
          <div class="tl-loading-spinner-wrap" aria-hidden="true">
            <div class="tl-loading-spinner"></div>
          </div>
          <p class="tl-loading-title">${_esc(title)}</p>
          <p class="tl-loading-detail">${detail}</p>
          <div class="tl-loading-hint">This may take a few seconds</div>
        </div>
      </div>`;
    _injectStyles();
  }

  function _renderError(message) {
    if (!_container) return;
    _container.innerHTML = `
      <div class="tl-loading tl-loading--error" role="alert">
        <div class="tl-loading-card tl-loading-card--error">
          <div class="tl-loading-icon-error" aria-hidden="true">!</div>
          <p class="tl-loading-title">Timeline error</p>
          <p class="tl-loading-detail tl-loading-detail--error">${_esc(message)}</p>
        </div>
      </div>`;
    _injectStyles();
  }

  // ── Main timeline render ───────────────────────────────────────────────────────

  function _renderTimeline() {
    if (!_container || !_store) return;

    _injectStyles();

    const steps = _store.steps || [];

    _container.innerHTML = `
      <div class="tl-root">
        <!-- Left: timeline (75%) -->
        <div class="tl-main" id="tl-main">
          <div class="tl-main-inner">
            <div class="tl-header-row">
              <button class="tl-exit-btn" id="tl-exit" title="Exit Timeline View">← Back to Test Results</button>
            </div>
            <div class="tl-context-label" id="tl-context"></div>
            <div class="tl-scrub-track" id="tl-scrub-track">
              <div class="tl-scrub-surface" aria-hidden="true"></div>
              <div class="tl-rail-clip" id="tl-rail-clip">
                <div class="tl-bar tl-bar--rail" id="tl-bar"></div>
              </div>
              <div class="tl-playhead" aria-hidden="true">
                <span class="tl-playhead-cap"></span>
                <span class="tl-playhead-line"></span>
              </div>
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
        </div>

        <!-- Draggable divider -->
        <div class="tl-resize-handle" id="tl-resize"></div>

        <!-- Right: console + errors (25%) -->
        <div class="tl-side" id="tl-side">
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
    _container.querySelectorAll('.tl-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        _container
          .querySelectorAll('.tl-tab')
          .forEach((b) => b.classList.remove('tl-tab--active'));
        btn.classList.add('tl-tab--active');
        _logContainer.style.display = _activeTab === 'console' ? '' : 'none';
        _errContainer.style.display = _activeTab === 'errors' ? '' : 'none';
      });
    });

    if (steps.length === 0) {
      _container.querySelector('#tl-context').textContent =
        'No steps recorded.';
      _updateLogPanel(null);
      return;
    }

    _engine = new PlaybackEngine(_store);
    _buildBar(steps);
    _bindControls();
    _bindResizeHandle();
    _bindExit();
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
      while (
        j < steps.length &&
        steps[j].line === s.line &&
        steps[j].file === s.file
      ) {
        j++;
      }
      const count = j - i;
      if (count > LOOP_THRESHOLD) {
        compressed.push({
          type: 'loop',
          steps: steps.slice(i, j),
          count,
          firstStepId: steps[i].stepId,
          lastStepId: steps[j - 1].stepId,
          file: s.file,
          line: s.line,
        });
      } else {
        for (let k = i; k < j; k++) {
          compressed.push({
            type: 'step',
            step: steps[k],
            firstStepId: steps[k].stepId,
            lastStepId: steps[k].stepId,
          });
        }
      }
      i = j;
    }

    if (_zoom === 'line') {
      return compressed;
    }

    // 2. Function or file zoom: group consecutive items with same key
    const keyFn =
      _zoom === 'function'
        ? (item) =>
            `${item.file || item.step?.file}::${item.step?.functionName || item.file || ''}`
        : (item) => item.file || item.step?.file || '';

    const grouped = [];
    let g = null;
    for (const item of compressed) {
      const key = keyFn(item);
      if (!g || g.key !== key) {
        g = {
          type: 'group',
          key,
          items: [item],
          firstStepId: item.firstStepId,
          lastStepId: item.lastStepId,
          label:
            _zoom === 'function'
              ? item.step?.functionName ||
                _basename(item.step?.file || item.file || '')
              : _basename(item.step?.file || item.file || ''),
        };
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
        box.dataset.lastStepId = String(item.lastStepId);
        if (_errorStepIds.has(item.step.stepId)) {
          box.classList.add('tl-box--error');
        }
        box.title = `${_basename(item.step.file)} · line ${item.step.line}`;
      } else if (item.type === 'loop') {
        box.className = 'tl-box tl-box--loop';
        box.dataset.firstStepId = String(item.firstStepId);
        box.dataset.lastStepId = String(item.lastStepId);
        box.title = `Loop ×${item.count} at line ${item.line}`;
        box.textContent = `×${item.count}`;
      } else {
        // group (zoom out)
        box.className = 'tl-box tl-box--group';
        box.dataset.firstStepId = String(item.firstStepId);
        box.dataset.lastStepId = String(item.lastStepId);
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

    // Drag scrubbing (pan rail; playhead stays centered)
    _bindDrag(bar);

    _bindRailResize();
    _railTranslateX = 0;
    if (_engine) {
      _syncRailToStep(_engine.currentStepId);
      requestAnimationFrame(() => {
        if (!_container || !_engine) return;
        _updateRailPadding();
        _syncRailToStep(_engine.currentStepId);
      });
    }
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
    } else {
      return;
    }
    _buildBar(_store.steps);
    _highlightActiveBox(_engine.currentStepId);
  }

  function _findBoxForStepId(bar, stepId) {
    const boxes = bar.querySelectorAll('[data-first-step-id]');
    for (const box of boxes) {
      const first = parseInt(box.dataset.firstStepId, 10);
      const last = parseInt(box.dataset.lastStepId, 10);
      if (stepId >= first && stepId <= last) {
        return box;
      }
    }
    return null;
  }

  function _updateRailPadding() {
    const bar = _container && _container.querySelector('#tl-bar');
    const clip = _container && _container.querySelector('#tl-rail-clip');
    if (!bar || !clip) return;
    const clipW = clip.clientWidth;
    const items = bar.querySelectorAll('[data-first-step-id]');
    if (items.length === 0) {
      bar.style.paddingLeft = '';
      bar.style.paddingRight = '';
      return;
    }
    const firstW = items[0].offsetWidth || 20;
    const lastW = items[items.length - 1].offsetWidth || 20;
    const pad = Math.max(0, clipW / 2 - firstW / 2);
    const padR = Math.max(0, clipW / 2 - lastW / 2);
    bar.style.paddingLeft = `${pad}px`;
    bar.style.paddingRight = `${padR}px`;
  }

  function _applyRailTransform(translateX, opts) {
    const bar = _container && _container.querySelector('#tl-bar');
    if (!bar) return;
    _railTranslateX = translateX;
    const playing = _engine && _engine.isPlaying();
    const smooth = opts && opts.smooth;
    const draggingRail = bar.classList.contains('tl-bar--dragging');
    if (!draggingRail && (smooth || playing)) {
      bar.classList.add('tl-bar--animated');
    } else {
      bar.classList.remove('tl-bar--animated');
    }
    bar.style.transform = `translate3d(${translateX}px,0,0)`;
  }

  /**
   * Keep the active step’s box centered under the fixed playhead.
   */
  function _syncRailToStep(stepId) {
    const bar = _container && _container.querySelector('#tl-bar');
    const clip = _container && _container.querySelector('#tl-rail-clip');
    if (!bar || !clip) return;

    _updateRailPadding();

    const box = _findBoxForStepId(bar, stepId);
    if (!box) {
      _applyRailTransform(0, { smooth: false });
      return;
    }

    const clipW = clip.clientWidth;
    const boxCenter = box.offsetLeft + box.offsetWidth / 2;
    const tx = clipW / 2 - boxCenter;
    _applyRailTransform(tx, { smooth: true });
  }

  function _highlightActiveBox(stepId) {
    const bar = _container && _container.querySelector('#tl-bar');
    if (!bar) return;
    bar
      .querySelectorAll('.tl-box--active')
      .forEach((el) => el.classList.remove('tl-box--active'));
    const box = _findBoxForStepId(bar, stepId);
    if (box) {
      box.classList.add('tl-box--active');
    }
    _syncRailToStep(stepId);
  }

  function _bindRailResize() {
    const track = _container && _container.querySelector('#tl-scrub-track');
    if (!track) return;
    if (_railResizeObserver) {
      _railResizeObserver.disconnect();
      _railResizeObserver = null;
    }
    _railResizeObserver = new ResizeObserver(() => {
      if (!_container || !_engine) return;
      _updateRailPadding();
      _syncRailToStep(_engine.currentStepId);
    });
    _railResizeObserver.observe(track);
  }

  /** Step id for the box whose center is nearest the playhead (viewport center of clip). */
  function _stepIdUnderPlayhead(bar) {
    const clip = _container && _container.querySelector('#tl-rail-clip');
    if (!clip || !bar) return null;
    const cr = clip.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    let best = null;
    let bestD = Infinity;
    for (const box of bar.querySelectorAll('[data-first-step-id]')) {
      const r = box.getBoundingClientRect();
      const bcx = r.left + r.width / 2;
      const d = Math.abs(bcx - cx);
      if (d < bestD) {
        bestD = d;
        best = parseInt(box.dataset.lastStepId, 10);
      }
    }
    return best;
  }

  // ── Drag scrubbing ─────────────────────────────────────────────────────────────

  const DRAG_SLOW_THROTTLE = 80; // ms

  function _bindDrag(bar) {
    const track = _container && _container.querySelector('#tl-scrub-track');
    if (!track) return;

    if (_dragAbort) {
      _dragAbort.abort();
    }
    _dragAbort = new AbortController();
    const dragSignal = _dragAbort.signal;

    let dragging = false;
    let lastThrottleTime = 0;
    let pendingStep = null;
    let dragStartClientX = 0;
    let dragStartTranslate = 0;

    const startDrag = (e) => {
      if (e.target && e.target.closest && e.target.closest('.tl-box')) {
        return;
      }
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      lastThrottleTime = 0;
      pendingStep = null;
      const clientX = e.type.startsWith('touch')
        ? e.touches[0].clientX
        : e.clientX;
      dragStartClientX = clientX;
      dragStartTranslate = _railTranslateX;
      bar.classList.add('tl-bar--dragging');
      e.preventDefault();
    };

    const moveDrag = (e) => {
      if (!dragging) return;
      const clientX = e.type.startsWith('touch')
        ? e.touches[0].clientX
        : e.clientX;
      const delta = clientX - dragStartClientX;
      _applyRailTransform(dragStartTranslate + delta, { smooth: false });

      const stepId = _stepIdUnderPlayhead(bar);
      if (stepId === null) return;
      pendingStep = stepId;

      const now = Date.now();
      if (now - lastThrottleTime >= DRAG_SLOW_THROTTLE) {
        lastThrottleTime = now;
        _engine.jumpTo(stepId);
        const step = _engine.currentStep;
        if (step) {
          const ctx = _container && _container.querySelector('#tl-context');
          if (ctx) {
            const file = _basename(step.file);
            const fn = step.functionName ? ` · ${step.functionName}` : '';
            ctx.textContent = `${file}${fn} · line ${step.line}`;
          }
          bar
            .querySelectorAll('.tl-box--active')
            .forEach((el) => el.classList.remove('tl-box--active'));
          const box = _findBoxForStepId(bar, step.stepId);
          if (box) {
            box.classList.add('tl-box--active');
          }
        }
      }
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('tl-bar--dragging');
      if (pendingStep !== null) {
        _engine.jumpTo(pendingStep);
        _applyStep(_engine.currentStep);
        pendingStep = null;
      } else {
        _syncRailToStep(_engine.currentStepId);
      }
    };

    track.addEventListener('mousedown', startDrag, { signal: dragSignal });
    window.addEventListener('mousemove', moveDrag, { signal: dragSignal });
    window.addEventListener('mouseup', endDrag, { signal: dragSignal });

    track.addEventListener('touchstart', startDrag, {
      passive: false,
      signal: dragSignal,
    });
    window.addEventListener('touchmove', moveDrag, {
      passive: true,
      signal: dragSignal,
    });
    window.addEventListener('touchend', endDrag, { signal: dragSignal });
    window.addEventListener('touchcancel', endDrag, { signal: dragSignal });
  }

  // ── Column resize ──────────────────────────────────────────────────────────────

  function _bindResizeHandle() {
    const handle = _container && _container.querySelector('#tl-resize');
    const main = _container && _container.querySelector('#tl-main');
    const root = _container && _container.querySelector('.tl-root');
    if (!handle || !main || !root) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startWidth = main.getBoundingClientRect().width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rootWidth = root.getBoundingClientRect().width;
      const newWidth = Math.max(
        100,
        Math.min(rootWidth - 80, startWidth + (e.clientX - startX)),
      );
      main.style.flex = 'none';
      main.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Controls ───────────────────────────────────────────────────────────────────

  function _bindControls() {
    const $ = (id) => _container.querySelector('#' + id);

    $('tl-first').addEventListener('click', () => {
      _applyStep(_engine.jumpToFirst());
    });
    $('tl-prev').addEventListener('click', () => {
      _applyStep(_engine.prev());
    });
    $('tl-next').addEventListener('click', () => {
      _applyStep(_engine.next());
    });
    $('tl-last').addEventListener('click', () => {
      _applyStep(_engine.jumpToLast());
    });

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

  function _bindExit() {
    const exitBtn = _container && _container.querySelector('#tl-exit');
    if (!exitBtn) return;
    exitBtn.addEventListener('click', () => {
      // Ask extension host to route both panels back in sync.
      if (_vscode) {
        _vscode.postMessage({ type: 'timeline-exit-request' });
      }
    });
  }

  function _updatePlayPause(playing) {
    if (!_container) return;
    const play = _container.querySelector('#tl-play');
    const pause = _container.querySelector('#tl-pause');
    if (!play || !pause) return;
    play.disabled = playing;
    pause.disabled = !playing;
  }

  // ── Step application ───────────────────────────────────────────────────────────

  function _applyStep(step) {
    if (!step || !_container) return;

    if (!_engine.isPlaying()) {
      _updatePlayPause(false);
    }

    // Context label
    const ctx = _container.querySelector('#tl-context');
    if (ctx) {
      const file = _basename(step.file);
      const fn = step.functionName ? ` · ${step.functionName}` : '';
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
      _vscode.postMessage({
        type: 'step-changed',
        stepId: step.stepId,
        filePath: step.file,
        line: step.line,
      });
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
    for (const step of _store.steps || []) {
      const stepLogs = _store.logs[step.stepId] || [];
      for (const entry of stepLogs) {
        lines.push({
          level: entry.level,
          text: `step ${step.stepId} · ${entry.text}`,
        });
      }
      if (step.stepId === currentStepId) {
        break;
      }
    }

    const sections =
      lines.length > 0
        ? [
            {
              scope: 'test',
              label: _store.testFullName || 'Test',
              capturedAt: null,
              lines,
            },
          ]
        : [];

    LogPanel.update(_logContainer, { sections });
  }

  function _renderErrorPanel() {
    if (!_errContainer || !window.ErrorPanel) return;

    const errors = _store && _store.errors ? _store.errors : [];
    const sections =
      errors.length > 0
        ? [
            {
              errors: errors.map((e) => ({
                testName: e.testName || _store.testFullName || 'Test',
                failureMessages: e.failureMessages,
              })),
            },
          ]
        : [];

    ErrorPanel.mount(_errContainer, { sections });
  }

  // ── Utility ────────────────────────────────────────────────────────────────────

  function _buildErrorSet() {
    _errorStepIds = new Set();
    if (!_store || !_store.errors) return;
    for (const e of _store.errors) {
      _errorStepIds.add(e.stepId);
    }
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
    let style = document.getElementById('tl-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'tl-styles';
      document.head.appendChild(style);
    }
    style.textContent = `
      .tl-loading {
        flex: 1;
        align-self: stretch;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 0;
        width: 100%;
        padding: 24px 20px;
        box-sizing: border-box;
        color: var(--vscode-foreground);
      }
      .tl-loading-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        max-width: 380px;
        width: 100%;
        padding: 28px 32px 26px;
        border-radius: 10px;
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.05),
          0 8px 24px rgba(0,0,0,0.12);
      }
      .tl-loading-card--error {
        border-color: var(--vscode-inputValidation-errorBorder, rgba(255,80,80,0.45));
        background: var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.08));
      }
      .tl-loading-spinner-wrap {
        width: 44px;
        height: 44px;
        margin-bottom: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .tl-loading-spinner {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 3px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
        border-top-color: var(--vscode-focusBorder, #007fd4);
        border-right-color: var(--vscode-focusBorder, #007fd4);
        animation: tl-spin 0.85s linear infinite;
      }
      .tl-loading-title {
        margin: 0 0 8px;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--vscode-foreground);
        opacity: 0.95;
      }
      .tl-loading-detail {
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        opacity: 0.88;
        word-break: break-word;
      }
      .tl-loading-detail--error {
        color: var(--vscode-errorForeground);
        opacity: 1;
      }
      .tl-loading-hint {
        margin-top: 16px;
        font-size: 11px;
        opacity: 0.55;
        letter-spacing: 0.02em;
      }
      .tl-loading-icon-error {
        width: 40px;
        height: 40px;
        margin-bottom: 14px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        font-weight: 700;
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.12));
        border: 2px solid var(--vscode-inputValidation-errorBorder, rgba(255,80,80,0.5));
      }
      .tl-loading--error .tl-loading-title {
        color: var(--vscode-errorForeground);
      }
      @keyframes tl-spin { to { transform: rotate(360deg); } }

      .tl-root {
        display: flex; flex: 1; width: 100%; height: 100%; overflow: hidden;
      }
      .tl-main {
        display: flex; flex-direction: column; flex: 3; min-width: 100px;
        min-height: 0;
        align-items: center;
        justify-content: center;
        padding: 10px 12px; box-sizing: border-box;
        overflow: hidden;
      }
      .tl-main-inner {
        display: flex; flex-direction: column;
        align-items: stretch;
        flex: 0 0 auto;
        width: 100%;
        max-width: min(920px, 100%);
        gap: 10px;
      }
      .tl-header-row {
        display: flex;
        justify-content: flex-end;
      }
      .tl-exit-btn {
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-panel-border, rgba(80,80,80,0.65));
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 11px;
        cursor: pointer;
      }
      .tl-exit-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground, #444);
        border-color: var(--vscode-focusBorder);
      }
      .tl-resize-handle {
        width: 4px; flex-shrink: 0; cursor: col-resize;
        background: transparent;
      }
      .tl-resize-handle:hover { background: var(--vscode-focusBorder); }
      .tl-side {
        display: flex; flex-direction: column; flex: 1;
        min-width: 80px; overflow: hidden;
        border-left: 1px solid var(--vscode-panel-border, #3c3c3c);
      }

      .tl-context-label {
        font-size: 11px; opacity: 0.88; flex-shrink: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        min-height: 16px; letter-spacing: 0.01em;
        text-align: center;
      }
      .tl-scrub-track {
        position: relative; flex: 0 0 auto;
        height: 58px;
        min-height: 52px;
        max-height: 64px;
        display: flex; align-items: center;
        border-radius: 8px;
        border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
        background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
        overflow: hidden;
      }
      .tl-scrub-surface {
        position: absolute; inset: 0; pointer-events: none;
        border-radius: 7px; margin: 2px;
        background: linear-gradient(
          180deg,
          rgba(255,255,255,0.04) 0%,
          transparent 42%,
          rgba(0,0,0,0.06) 100%
        );
      }
      .tl-rail-clip {
        position: relative; z-index: 1;
        flex: 1; height: 100%;
        overflow: hidden;
        display: flex; align-items: center;
        cursor: grab;
        touch-action: pan-y;
      }
      .tl-rail-clip:active { cursor: grabbing; }
      .tl-bar.tl-bar--rail {
        display: flex; gap: 6px; align-items: center;
        flex-shrink: 0; box-sizing: content-box;
        padding-top: 8px; padding-bottom: 8px;
        will-change: transform;
      }
      .tl-bar.tl-bar--rail.tl-bar--animated {
        transition: transform 0.18s cubic-bezier(0.25, 0.8, 0.25, 1);
      }
      .tl-playhead {
        position: absolute; left: 50%; top: 0; bottom: 0; z-index: 2;
        display: flex; flex-direction: column; align-items: center;
        pointer-events: none;
        transform: translateX(-50%);
      }
      .tl-playhead-cap {
        width: 0; height: 0;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 6px solid var(--vscode-focusBorder, #007fd4);
        opacity: 0.95;
      }
      .tl-playhead-line {
        flex: 1; width: 2px; min-height: 8px;
        margin-top: -1px;
        border-radius: 1px;
        background: var(--vscode-focusBorder, #007fd4);
        box-shadow: 0 0 5px rgba(0, 120, 212, 0.35);
      }
      .tl-box {
        width: 20px; height: 32px; flex-shrink: 0;
        border-radius: 5px; cursor: pointer;
        box-sizing: border-box;
        background: var(--vscode-editor-background, #1e1e1e);
        border: 2px solid var(--vscode-widget-border, rgba(140,140,140,0.55));
        box-shadow:
          0 0 0 1px rgba(0,0,0,0.25) inset,
          0 2px 4px rgba(0,0,0,0.2);
        transition: background 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.12s;
      }
      .tl-box:hover {
        border-color: var(--vscode-focusBorder);
        background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
        transform: translateY(-2px);
        box-shadow:
          0 0 0 1px rgba(0,0,0,0.2) inset,
          0 3px 8px rgba(0,0,0,0.25);
      }
      .tl-box--active {
        background: var(--vscode-button-background, #0e639c);
        border-color: var(--vscode-focusBorder, #007fd4);
        border-width: 2px;
        box-shadow:
          0 0 0 1px rgba(255,255,255,0.12) inset,
          0 0 0 1px var(--vscode-focusBorder, #007fd4),
          0 3px 12px rgba(0,0,0,0.35);
      }
      .tl-box--error {
        background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
        border-color: var(--vscode-inputValidation-errorBorder, #be1100);
      }
      .tl-box--error.tl-box--active { background: var(--vscode-errorForeground, #f48771); }
      .tl-box--loop {
        width: auto; min-width: 36px; min-height: 32px; padding: 0 8px;
        font-size: 10px; font-weight: 600;
        color: var(--vscode-foreground);
        letter-spacing: 0.02em;
        display: flex; align-items: center; justify-content: center;
        background: repeating-linear-gradient(
          135deg,
          var(--vscode-editor-background, #1e1e1e) 0px,
          var(--vscode-editor-background, #1e1e1e) 5px,
          var(--vscode-button-secondaryBackground, #3c3c3c) 5px,
          var(--vscode-button-secondaryBackground, #3c3c3c) 10px
        );
        border: 2px solid var(--vscode-focusBorder, #007fd4);
      }
      .tl-box--group {
        width: auto; min-width: 48px; max-width: 100px; min-height: 32px; padding: 0 8px;
        font-size: 10px; font-weight: 600;
        color: var(--vscode-foreground);
        display: flex; align-items: center; justify-content: center;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        background: var(--vscode-editor-background, #1e1e1e);
        border: 2px solid var(--vscode-widget-border, rgba(140,140,140,0.55));
      }

      .tl-controls {
        display: flex; justify-content: center; align-items: center;
        gap: 4px; flex-shrink: 0;
      }
      .tl-btn {
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        border: 1px solid var(--vscode-panel-border, rgba(80,80,80,0.65));
        color: var(--vscode-foreground); border-radius: 6px;
        padding: 5px 10px; cursor: pointer; font-size: 12px; min-width: 32px;
        line-height: 1;
        transition: background 0.12s, border-color 0.12s, opacity 0.12s;
      }
      .tl-btn:hover:not(:disabled) {
        background: var(--vscode-button-secondaryHoverBackground, #444);
        border-color: var(--vscode-focusBorder);
      }
      .tl-btn:disabled { opacity: 0.38; cursor: default; }

      .tl-step-count {
        font-size: 11px; opacity: 0.65; text-align: center; flex-shrink: 0;
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
