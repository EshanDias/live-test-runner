/**
 * timelineSidebar.js — timeline debugger sidebar for ExplorerView (explorer.html).
 *
 * Mounted when the router receives { type: 'route', view: 'timelineSidebar' }.
 *
 * Sections:
 *   Re-run button
 *   State   — variables captured at the current step
 *   Watch   — user-pinned variables with their value at the current step
 *   Call Stack — function chain at the current step (from step.functionName + file)
 */

(function () {
  // ── Module-level state ────────────────────────────────────────────────────────

  let _vscode = null;
  let _container = null;
  let _store = null;         // serialised TimelineStore
  let _currentStepId = null;
  let _watchList = [];       // array of variable name strings
  let _running = false;

  // ── Public view interface ─────────────────────────────────────────────────────

  const TimelineSidebar = {
    mount(container, vscode, payload) {
      _container = container;
      _vscode = vscode;
      _store = null;
      _currentStepId = null;
      _watchList = [];
      _running = false;

      _renderShell(payload && payload.testFullName);
    },

    unmount() {
      _container = null;
      _vscode = null;
      _store = null;
    },

    onMessage(msg) {
      if (msg.type === 'timeline-loading') {
        _running = true;
        _updateRerunBtn();
        return;
      }
      if (msg.type === 'timeline-ready') {
        _store = msg.store;
        _running = false;
        // Move to first step
        _currentStepId = _store.steps && _store.steps.length > 0
          ? _store.steps[0].stepId
          : null;
        _updateRerunBtn();
        _updateTestName(_store.testFullName);
        _renderState();
        _renderWatch();
        _renderCallStack();
        return;
      }
      if (msg.type === 'step-update') {
        _currentStepId = msg.stepId;
        _renderState();
        _renderWatch();
        _renderCallStack();
        return;
      }
      if (msg.type === 'add-to-watch' && msg.varName) {
        _addWatch(msg.varName);
        return;
      }
    },
  };

  // ── Shell render ───────────────────────────────────────────────────────────────

  function _renderShell(testName) {
    if (!_container) return;
    _injectStyles();

    _container.innerHTML = `
      <div class="ts-root">
        <div class="ts-header">
          <div class="ts-test-name" id="ts-test-name">${_esc(testName || 'Timeline Debugger')}</div>
          <button class="ts-rerun-btn" id="ts-rerun" title="Re-run instrumented trace">↺ Re-run</button>
        </div>

        <div class="ts-section">
          <div class="ts-section-title">STATE</div>
          <div id="ts-state" class="ts-section-body ts-empty">—</div>
        </div>

        <div class="ts-section">
          <div class="ts-section-title">WATCH</div>
          <div id="ts-watch" class="ts-section-body">
            <div class="ts-watch-input-row">
              <input id="ts-watch-input" class="ts-input" type="text" placeholder="+ add variable" />
              <button id="ts-watch-add" class="ts-add-btn" title="Add to watch">+</button>
            </div>
            <div id="ts-watch-list"></div>
          </div>
        </div>

        <div class="ts-section">
          <div class="ts-section-title">CALL STACK</div>
          <div id="ts-callstack" class="ts-section-body ts-empty">—</div>
        </div>
      </div>`;

    _container.querySelector('#ts-rerun').addEventListener('click', () => {
      if (_running) return;
      _vscode && _vscode.postMessage({ type: 'timeline-rerun' });
    });

    const input = _container.querySelector('#ts-watch-input');
    const addBtn = _container.querySelector('#ts-watch-add');
    const doAdd = () => {
      const v = input.value.trim();
      if (v) { _addWatch(v); input.value = ''; }
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  }

  // ── Section updaters ───────────────────────────────────────────────────────────

  function _updateTestName(name) {
    const el = _container && _container.querySelector('#ts-test-name');
    if (el) el.textContent = name || 'Timeline Debugger';
  }

  function _updateRerunBtn() {
    const btn = _container && _container.querySelector('#ts-rerun');
    if (!btn) return;
    btn.disabled = _running;
    btn.textContent = _running ? '↺ Running…' : '↺ Re-run';
  }

  function _renderState() {
    const el = _container && _container.querySelector('#ts-state');
    if (!el) return;

    const vars = _currentStepId !== null && _store
      ? (_store.variables[_currentStepId] || [])
      : [];

    if (vars.length === 0) {
      el.innerHTML = '<span class="ts-empty">No variables at this step.</span>';
      return;
    }

    el.innerHTML = '';
    for (const snap of vars) {
      el.appendChild(_buildVarRow(snap));
    }
  }

  function _renderWatch() {
    const el = _container && _container.querySelector('#ts-watch-list');
    if (!el) return;

    if (_watchList.length === 0) {
      el.innerHTML = '';
      return;
    }

    const vars = _currentStepId !== null && _store
      ? (_store.variables[_currentStepId] || [])
      : [];
    const varMap = {};
    for (const v of vars) { varMap[v.name] = v; }

    el.innerHTML = '';
    for (const name of _watchList) {
      const snap = varMap[name];
      const row = document.createElement('div');
      row.className = 'ts-var-row ts-watch-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'ts-var-name';
      nameEl.textContent = name;

      const valEl = document.createElement('span');
      valEl.className = 'ts-var-value';
      valEl.textContent = snap ? _formatValue(snap) : '—';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'ts-remove-btn';
      removeBtn.title = 'Remove from watch';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        _watchList = _watchList.filter(n => n !== name);
        _renderWatch();
      });

      row.appendChild(nameEl);
      row.appendChild(valEl);
      row.appendChild(removeBtn);
      el.appendChild(row);
    }
  }

  function _renderCallStack() {
    const el = _container && _container.querySelector('#ts-callstack');
    if (!el) return;

    if (_currentStepId === null || !_store || !_store.steps) {
      el.innerHTML = '<span class="ts-empty">—</span>';
      return;
    }

    // Build call stack: find the current step and show function + file info.
    // For MVP: just the current step's function; a full call stack would require
    // the instrumentation to emit stack frames separately.
    const step = _store.steps.find(s => s.stepId === _currentStepId);
    if (!step) {
      el.innerHTML = '<span class="ts-empty">—</span>';
      return;
    }

    el.innerHTML = '';
    const frame = document.createElement('div');
    frame.className = 'ts-callstack-frame';

    const fnName = step.functionName || '(anonymous)';
    const file   = _basename(step.file);
    const line   = step.line;

    frame.textContent = `${fnName}  ${file}:${line}`;
    frame.title = `${step.file}:${line}`;
    frame.addEventListener('click', () => {
      _vscode && _vscode.postMessage({ type: 'open-file', filePath: step.file, line });
    });

    el.appendChild(frame);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  function _addWatch(varName) {
    if (!_watchList.includes(varName)) {
      _watchList.push(varName);
      _renderWatch();
    }
  }

  function _buildVarRow(snap) {
    const row = document.createElement('div');
    row.className = 'ts-var-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'ts-var-name';
    nameEl.textContent = snap.name;

    const valEl = document.createElement('span');
    valEl.className = 'ts-var-value';

    if (snap.type === 'object' || snap.type === 'array') {
      // Lazy expandable
      const toggle = document.createElement('button');
      toggle.className = 'ts-expand-btn';
      toggle.textContent = '▶';
      toggle.addEventListener('click', () => {
        const expanded = toggle.textContent === '▼';
        toggle.textContent = expanded ? '▶' : '▼';
        childList.style.display = expanded ? 'none' : 'block';
      });

      const childList = document.createElement('div');
      childList.className = 'ts-var-children';
      childList.style.display = 'none';
      if (snap.keys && snap.keys.length > 0) {
        for (const key of snap.keys) {
          const child = document.createElement('div');
          child.className = 'ts-var-child';
          child.textContent = key;
          childList.appendChild(child);
        }
      } else {
        childList.textContent = snap.type === 'array' ? '[]' : '{}';
      }

      valEl.textContent = snap.type === 'array' ? `[…]` : `{…}`;
      row.appendChild(toggle);
      row.appendChild(nameEl);
      row.appendChild(valEl);
      row.appendChild(childList);
    } else {
      valEl.textContent = _formatValue(snap);
      row.appendChild(nameEl);
      row.appendChild(valEl);
    }

    return row;
  }

  function _formatValue(snap) {
    if (snap.type === 'object') return '{…}';
    if (snap.type === 'array')  return '[…]';
    if (snap.value === undefined) return 'undefined';
    if (snap.value === null)      return 'null';
    if (typeof snap.value === 'string') return `"${snap.value}"`;
    return String(snap.value);
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
    if (document.getElementById('ts-styles')) return;
    const style = document.createElement('style');
    style.id = 'ts-styles';
    style.textContent = `
      .ts-root {
        display: flex; flex-direction: column;
        height: 100%; overflow-y: auto;
        font-size: 12px; color: var(--vscode-foreground);
        box-sizing: border-box; padding: 0 0 12px;
      }
      .ts-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px 6px; gap: 6px; flex-shrink: 0;
        border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      }
      .ts-test-name {
        font-size: 11px; opacity: 0.75;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
      }
      .ts-rerun-btn {
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        color: var(--vscode-button-secondaryForeground, #ccc);
        border: none; border-radius: 3px; padding: 2px 8px;
        cursor: pointer; font-size: 11px; white-space: nowrap;
        flex-shrink: 0;
      }
      .ts-rerun-btn:hover:not(:disabled) { opacity: 0.85; }
      .ts-rerun-btn:disabled { opacity: 0.4; cursor: default; }

      .ts-section { border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); }
      .ts-section-title {
        font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
        opacity: 0.55; padding: 6px 10px 3px; text-transform: uppercase;
      }
      .ts-section-body { padding: 2px 10px 8px; }
      .ts-empty { opacity: 0.45; font-style: italic; }

      .ts-var-row {
        display: flex; align-items: baseline; gap: 4px;
        padding: 2px 0; flex-wrap: wrap;
      }
      .ts-var-name { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); min-width: 60px; }
      .ts-var-value { opacity: 0.8; font-family: monospace; word-break: break-all; }
      .ts-var-children {
        margin-left: 16px; padding: 2px 0;
        border-left: 1px solid var(--vscode-panel-border, #3c3c3c);
        padding-left: 6px; width: 100%;
      }
      .ts-var-child { opacity: 0.7; padding: 1px 0; }

      .ts-expand-btn {
        background: none; border: none; color: var(--vscode-foreground);
        cursor: pointer; padding: 0 2px; font-size: 9px; opacity: 0.7;
      }

      .ts-watch-input-row { display: flex; gap: 4px; padding: 2px 0 6px; }
      .ts-input {
        flex: 1; background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 3px; padding: 2px 6px; font-size: 11px;
      }
      .ts-add-btn {
        background: var(--vscode-button-secondaryBackground, #3c3c3c);
        color: var(--vscode-foreground); border: none; border-radius: 3px;
        padding: 2px 6px; cursor: pointer;
      }
      .ts-watch-row { position: relative; }
      .ts-remove-btn {
        background: none; border: none; color: var(--vscode-foreground);
        cursor: pointer; opacity: 0.4; padding: 0 2px; margin-left: auto;
        font-size: 13px; line-height: 1;
      }
      .ts-remove-btn:hover { opacity: 0.9; }

      .ts-callstack-frame {
        padding: 2px 0; cursor: pointer; opacity: 0.85; font-family: monospace;
        font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ts-callstack-frame:hover { opacity: 1; text-decoration: underline; }
    `;
    document.head.appendChild(style);
  }

  window.TimelineSidebar = TimelineSidebar;
})();
