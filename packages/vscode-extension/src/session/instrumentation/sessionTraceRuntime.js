'use strict';
/**
 * sessionTraceRuntime.js — runtime injected into all instrumented files during
 * a session trace run (distinct from traceRuntime.js which serves the Timeline Debugger).
 *
 * Maintains the current execution context (which test / hook is running) and
 * writes each step as a JSON line to SESSION_TRACE_FILE.
 *
 * Context lifecycle (driven by sessionTraceTransform.js injections):
 *   __strace.enterTest(name)  — called at the start of an it/test callback
 *   __strace.exitTest()       — called at the end of an it/test callback
 *   __strace.enterHook(type)  — called at the start of beforeAll/beforeEach/afterEach/afterAll
 *   __strace.exitHook()       — called at the end of a hook callback
 *
 * The runtime is required once per Jest worker process. Because the global is
 * set on the Node.js `global` object, it survives across multiple require() calls
 * within the same worker.
 */

const fs = require('fs');

const outputFile = process.env.SESSION_TRACE_FILE;

// ---------------------------------------------------------------------------
// Context state — mutated by enter/exit calls injected by sessionTraceTransform
// ---------------------------------------------------------------------------
let _currentTestName = null;   // set only when inside an it/test body
let _currentContext  = null;   // 'beforeAll' | 'beforeEach' | 'test' | 'afterEach' | 'afterAll'
let _lastTestName    = null;   // the most recently exited test — used to tag afterEach/afterAll steps

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------
function writeStep(event) {
  if (!outputFile) { return; }
  try {
    fs.appendFileSync(outputFile, JSON.stringify(event) + '\n', 'utf8');
  } catch (_e) {
    // tracing must never crash the test
  }
}

function safeValue(value) {
  if (value === null || value === undefined) { return { type: 'primitive', value }; }
  if (typeof value !== 'object') { return { type: 'primitive', value }; }
  if (Array.isArray(value)) {
    return { type: 'array', count: value.length };
  }
  let keys;
  try { keys = Object.keys(value).slice(0, 50); } catch (_e) { keys = []; }
  return { type: 'object', keys };
}

// ---------------------------------------------------------------------------
// Global __strace — the API called by instrumented code
// ---------------------------------------------------------------------------
if (!global.__strace) {
  // Patch console methods to emit LOG events attributed to the active test.
  // Must happen before any test code runs, and only once per worker process.
  const _origLog   = console.log.bind(console);
  const _origInfo  = console.info.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _origError = console.error.bind(console);

  global.__strace = {
    // ── Context management ──────────────────────────────────────────────────

    enterTest(name) {
      _currentTestName = name;
      _currentContext  = 'test';
    },

    exitTest() {
      _lastTestName    = _currentTestName;
      _currentTestName = null;
      _currentContext  = null;
    },

    enterHook(type) {
      // afterEach/afterAll run after a test — attribute them to the last test name
      if (type === 'afterEach' || type === 'afterAll') {
        _currentTestName = _lastTestName;
      }
      _currentContext = type;
    },

    exitHook() {
      if (_currentContext === 'afterEach' || _currentContext === 'afterAll') {
        _currentTestName = null;
      }
      _currentContext = null;
    },

    // ── Instrumentation calls ───────────────────────────────────────────────

    step(line, file) {
      writeStep({
        type:     'STEP',
        line,
        file,
        context:  _currentContext,
        testName: _currentTestName,
      });
    },

    var(line, file, name, value) {
      writeStep({
        type:     'VAR',
        line,
        file,
        name,
        value:    safeValue(value),
        context:  _currentContext,
        testName: _currentTestName,
      });
    },

    log(level, ...args) {
      writeStep({
        type:     'LOG',
        level,
        args:     args.map((a) => {
          if (a === null || a === undefined) { return String(a); }
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (_e) { return String(a); }
          }
          return String(a);
        }),
        context:  _currentContext,
        testName: _currentTestName,
      });
    },
  };

  console.log   = (...args) => { global.__strace.log('log',   ...args); _origLog(...args); };
  console.info  = (...args) => { global.__strace.log('info',  ...args); _origInfo(...args); };
  console.warn  = (...args) => { global.__strace.log('warn',  ...args); _origWarn(...args); };
  console.error = (...args) => { global.__strace.log('error', ...args); _origError(...args); };
}
