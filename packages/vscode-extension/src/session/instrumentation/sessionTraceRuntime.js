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

/**
 * The open context: { kind: 'T' | 'H', file, name?, hk?, hits: Map<srcFile, Set<line>> }.
 * ltrCoverageSetup.js opens and closes it around every test (beginTest, endTest, ...).
 */
let _ctx = null;
/**
 * Test/hook wrappers injected into instrumented non-test files (e.g. a
 * beforeEach in setupTests.js) that ran inside the open context. They add
 * their hits to it instead of replacing it — replacing it threw away the
 * running test's hits, so no per-test trace was ever recorded on such projects.
 */
let _depth = 0;

function flush() {
  const ctx = _ctx;
  _ctx = null;
  _depth = 0;
  if (!outputFile || !ctx || ctx.hits.size === 0) { return; }
  const fh = {};
  for (const [file, lines] of ctx.hits) {
    fh[file] = Array.from(lines);
  }
  // hk = hook kind: 'file' (module-level code run while the test file loads),
  // 'hook' (beforeAll/afterAll between tests) or a hook name.
  const rec = ctx.kind === 'T'
    ? { type: 'T', tf: ctx.file, tn: ctx.name, fh }
    : { type: 'H', tf: ctx.file, hk: ctx.hk, fh };
  try {
    fs.appendFileSync(outputFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_e) {
    process.stderr.write(`[LTR:error] trace: could not write ${outputFile} — ${_e.message}\n`);
  }
}

function open(kind, file, extra) {
  flush();
  _ctx = { kind, file, hits: new Map(), ...extra };
}

if (!global.__strace) {
  global.__strace = {
    // ── Test boundaries, driven by ltrCoverageSetup.js ───────────────────────
    beginFile(testFile) { open('H', testFile, { hk: 'file' }); },
    beginTest(name, testFile) { open('T', testFile, { name }); },
    /** After a test: anything until the next test is a file-wide hook. */
    endTest(testFile) { open('H', testFile, { hk: 'hook' }); },
    finish() { flush(); },

    // ── Injected around test / hook callbacks in instrumented files ─────────
    enterTest(name, testFile) {
      if (_ctx) { _depth++; return; }
      open('T', testFile, { name });
    },
    exitTest() {
      if (_depth > 0) { _depth--; return; }
      flush();
    },
    enterHook(type, testFile) {
      if (_ctx) { _depth++; return; }
      open('H', testFile, { hk: type });
    },
    exitHook() {
      if (_depth > 0) { _depth--; return; }
      flush();
    },

    step(line, file) {
      if (!_ctx) { return; }
      let set = _ctx.hits.get(file);
      if (!set) { set = new Set(); _ctx.hits.set(file, set); }
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
