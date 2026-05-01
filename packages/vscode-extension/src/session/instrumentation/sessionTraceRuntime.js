'use strict';
/**
 * sessionTraceRuntime.js — light-trace runtime.
 *
 * Records only which (file, line) pairs were hit by which test. One compact
 * JSONL record is flushed per test body and per hook block. No variable
 * capture, no console patching, no per-step streaming.
 *
 * Record formats:
 *   {"type":"T","tf":"/abs/test.ts","tn":"Suite > name","fh":{"/abs/src.ts":[12,13]}}
 *   {"type":"H","tf":"/abs/test.ts","fh":{"/abs/src.ts":[1,2]}}
 */

const fs = require('fs');

const outputFile    = process.env.SESSION_TRACE_FILE;
const covOutputFile = process.env.COVERAGE_OUTPUT_FILE;

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
  const rec = type === 'T'
    ? { type: 'T', tf: _currentTestFile, tn: _currentTestName, fh }
    : { type: 'H', tf: _currentTestFile, fh };
  try {
    fs.appendFileSync(outputFile, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_e) {
    process.stderr.write(`[LTR][Coverage] sessionTraceRuntime flushRecord: FAILED to write "${outputFile}" — ${_e.message}\n`);
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

// Flush coverage counters to COVERAGE_OUTPUT_FILE on process exit.
// appendFileSync is intentional — multiple Jest workers write to the same file.
process.on('exit', () => {
  if (!covOutputFile || !globalThis.__cov) { return; }
  try {
    fs.appendFileSync(
      covOutputFile,
      JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n',
      'utf8',
    );
  } catch (_e) {
    process.stderr.write(`[LTR][Coverage] sessionTraceRuntime exit: FAILED to write "${covOutputFile}" — ${_e.message}\n`);
  }
});
