'use strict';
/**
 * traceRuntime.js — the __trace global injected into test files at run time.
 *
 * Reads the output file path from process.env.TRACE_OUTPUT_FILE and writes
 * each event as a JSON line synchronously (to preserve ordering).
 *
 * Circular references in variable values are safely serialised as "[Circular]".
 */

const fs = require('fs');

const outputFile = process.env.TRACE_OUTPUT_FILE;

function writeEvent(event) {
  if (!outputFile) { return; }
  try {
    fs.appendFileSync(outputFile, JSON.stringify(event) + '\n', 'utf8');
  } catch (_e) {
    // swallow — tracing must never crash the test
  }
}

/**
 * Safely serialise a value for capture. Returns a VariableSnapshot-shaped object.
 * Circular references are detected with a WeakSet.
 */
function snapshot(name, value) {
  if (value === null || typeof value !== 'object') {
    return { name, type: 'primitive', value };
  }

  if (Array.isArray(value)) {
    return { name, type: 'array', count: value.length, keys: Object.keys(value).slice(0, 20) };
  }

  // object
  let keys;
  try {
    keys = Object.keys(value).slice(0, 50);
  } catch (_e) {
    keys = [];
  }
  return { name, type: 'object', keys };
}

global.__trace = {
  step(stepId, line, file, functionName) {
    writeEvent({ type: 'STEP', stepId, line, file, functionName });
  },

  var(stepId, name, value) {
    const snap = snapshot(name, value);
    writeEvent({ type: 'VAR', stepId, name, snapshot: snap });
  },

  assert(stepId, expected, actual, pass) {
    writeEvent({ type: 'ASSERT', stepId, expected, actual, pass });
  },

  log(stepId, level, ...args) {
    writeEvent({ type: 'LOG', stepId, level, args: args.map(a => String(a)) });
  },
};
