'use strict';
/**
 * sessionTraceRuntime.js — light-trace runtime.
 *
 * Records only which (file, line) pairs were hit by which test. One compact
 * JSONL record is flushed per test body and per hook block. No variable
 * capture, no console patching, no per-step streaming.
 *
 * Record formats:
 *   {"type":"T","tf":"/abs/test.ts","tn":"Suite name","fh":{"/abs/src.ts":[12,13]}}
 *   {"type":"H","tf":"/abs/test.ts","hk":"hook","fh":{"/abs/src.ts":[1,2]}}
 */

// Inside Jest this module lives in the test's module registry, where the test
// may have mocked fs (jest.mock('fs')) — always use the real one.
// eslint-disable-next-line no-undef
const fs = (typeof jest !== 'undefined' && jest.requireActual) ? jest.requireActual('fs') : require('fs');

const outputFile    = process.env.SESSION_TRACE_FILE;

let _currentTestName = null;
let _currentTestFile = null;
let _currentContext  = null;
let _hits            = null;   // Map<srcFile, Set<line>>

function flushRecord(type) {
  if (!outputFile || !_hits || _hits.size === 0) { _hits = null; return; }
  const fh = {};
  for (const [file, lines] of _hits) {
    fh[file] = Array.from(lines);
  }
  // hk = hook kind: 'file' (module-level code run while the test file loads),
  // 'hook' (beforeAll/afterAll between tests) or a hook name.
  const rec = type === 'T'
    ? { type: 'T', tf: _currentTestFile, tn: _currentTestName, fh }
    : { type: 'H', tf: _currentTestFile, hk: _currentContext, fh };
  try {
    fs.appendFileSync(outputFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_e) {
    process.stderr.write(`[LTR:error] trace: could not write ${outputFile} — ${_e.message}\n`);
  }
  _hits = null;
}

if (!global.__strace) {
  global.__strace = {
    enterTest(name, testFile) {
      _currentTestName = name;
      _currentTestFile = testFile;
      _currentContext  = 'test';
      _hits            = new Map();
    },

    exitTest() {
      flushRecord('T');
      _currentTestName = null;
      _currentContext  = null;
    },

    enterHook(type, testFile) {
      _currentTestFile = testFile;
      _currentContext  = type;
      _hits            = new Map();
    },

    exitHook() {
      flushRecord('H');
      _currentContext = null;
    },

    step(line, file) {
      if (!_hits) { return; }
      let set = _hits.get(file);
      if (!set) { set = new Set(); _hits.set(file, set); }
      set.add(line);
    },

    // No-ops — kept so any code compiled against the old heavy-trace API still works
    var() {},
    log() {},
  };
}

// Coverage counters are flushed by ltrCoverageSetup.js in afterAll. There is
// deliberately no process.on('exit') handler here: this module is loaded once
// per test file (fresh module registry), so each load added another listener
// (MaxListenersExceededWarning, N duplicate flushes — BUG-19), and Jest's
// --forceExit kills workers before 'exit' handlers run anyway.
