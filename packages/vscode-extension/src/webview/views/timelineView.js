/**
 * timelineView.js — timeline debugger view for ResultsView (results.html).
 *
 * Mounted when the router receives { type: 'route', view: 'timeline' }.
 * Receives { type: 'timeline-loading' } to show a spinner while Jest runs.
 * Receives { type: 'timeline-ready', store } when the trace is ready.
 *
 * Task 11: timeline bar + playback controls.
 * Task 14: log/error panels wired in.
 * Task 16: drag + zoom.
 * Task 17: loop compression.
 */

(function () {
  // ── Module-level state ────────────────────────────────────────────────────────

  let _vscode = null;
  let _container = null;
  let _engine = null;   // PlaybackEngine instance
  let _store = null;    // serialised TimelineStore (variables/logs as plain objects)
  let _errorStepIds = new Set(); // stepIds that have errors

  // ── Mount / unmount ────────────────────────────────────────────────────────────

  const TimelineView = {
    mount(container, vscode, payload) {
      _container = container;
      _vscode = vscode;
      _engine = null;
      _store = null;
      _errorStepIds = new Set();

      _renderLoading(payload && payload.testFullName);
    },

    unmount() {
      if (_engine) { _engine.pause(); }
      // Notify extension host that timeline mode is ending so it can clear decorations.
      if (_vscode) { _vscode.postMessage({ type: 'timeline-exited' }); }
      _engine = null;
      _store = null;
      _container = null;
      _vscode = null;
    },

    onMessage(msg) {
      if (msg.type === 'timeline-loading') {
        _renderLoading(_store ? _store.testFullName : undefined);
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

  // ── Rendering helpers ──────────────────────────────────────────────────────────

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

  function _renderTimeline() {
    if (!_container || !_store) return;

    const steps = _store.steps || [];

    _container.innerHTML = `
      <div class="tl-root">
        <div class="tl-context-label" id="tl-context"></div>
        <div class="tl-bar-wrap">
          <div class="tl-bar" id="tl-bar"></div>
        </div>
        <div class="tl-controls" id="tl-controls">
          <button class="tl-btn" id="tl-first"  title="First step">⏮</button>
          <button class="tl-btn" id="tl-prev"   title="Step back">◀</button>
          <button class="tl-btn" id="tl-play"   title="Play">▶</button>
          <button class="tl-btn" id="tl-next"   title="Step forward">▶|</button>
          <button class="tl-btn" id="tl-last"   title="Last step">⏭</button>
          <button class="tl-btn" id="tl-pause"  title="Pause">⏸</button>
        </div>
        <div class="tl-step-count" id="tl-step-count"></div>
      </div>`;

    _injectStyles();

    if (steps.length === 0) {
      _container.querySelector('#tl-context').textContent = 'No steps recorded.';
      return;
    }

    // Instantiate the PlaybackEngine (loaded as a <script> before this view)
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
    const play  = _container && _container.querySelector('#tl-play');
    const pause = _container && _container.querySelector('#tl-pause');
    if (!play || !pause) return;
    play.disabled  = playing;
    pause.disabled = !playing;
  }

  // ── Step application ───────────────────────────────────────────────────────────

  function _applyStep(step) {
    if (!step || !_container) return;

    // If auto-play has naturally ended (at last step), reset play/pause buttons
    if (!_engine.isPlaying()) { _updatePlayPause(false); }

    // Update context label
    const ctx = _container.querySelector('#tl-context');
    if (ctx) {
      const file = _basename(step.file);
      const fn   = step.functionName ? ` · ${step.functionName}` : '';
      ctx.textContent = `${file}${fn} · line ${step.line}`;
    }

    // Update step counter
    const counter = _container.querySelector('#tl-step-count');
    if (counter) {
      counter.textContent = `Step ${_engine.currentStepId} of ${_engine.stepCount}`;
    }

    // Highlight the active box in the bar
    const bar = _container.querySelector('#tl-bar');
    if (bar) {
      bar.querySelectorAll('.tl-box--active').forEach(el => el.classList.remove('tl-box--active'));
      const active = bar.querySelector(`[data-step-id="${step.stepId}"]`);
      if (active) {
        active.classList.add('tl-box--active');
        active.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
    }

    // Notify extension host — editor highlight happens in task 13
    if (_vscode) {
      _vscode.postMessage({ type: 'step-changed', stepId: step.stepId, filePath: step.file, line: step.line });
    }
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
        display: flex; flex-direction: column;
        height: 100%; padding: 8px 12px; box-sizing: border-box;
        gap: 6px;
      }
      .tl-context-label {
        font-size: 11px; opacity: 0.75;
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
        padding: 3px 8px; cursor: pointer; font-size: 13px;
        min-width: 28px;
      }
      .tl-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #444); }
      .tl-btn:disabled { opacity: 0.4; cursor: default; }

      .tl-step-count {
        font-size: 10px; opacity: 0.55; text-align: center; flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  window.TimelineView = TimelineView;
})();
