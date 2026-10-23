/**
 * vitestTraceSetup.mjs — the first `test.setupFiles` entry of a traced Vitest
 * run (added by vitestTracePlugin.js). Runs in the worker before each test
 * file.
 *
 * Opens and closes the trace runtime's context (shared/sessionTraceRuntime.js,
 * loaded with Node's own require so `vi.mock('fs')` cannot reach it) around
 * every test, like the Jest setup file:
 *
 *   setup → root beforeAll : 'H' file  — module-level code of imported files
 *   root beforeAll …       : 'H' hook  — beforeAll hooks (count for every test)
 *   beforeEach … afterEach : 'T' test  — that test, its beforeEach / afterEach hooks
 *   between tests          : 'H' hook  — beforeAll / afterAll of nested suites
 *
 * A test's name is its suites' names and its own, joined by spaces — the
 * full name the results use (ResultStore, `nameToPattern`).
 */
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';

const require_ = createRequire(import.meta.url);
const strace = (() => {
  try {
    return require_('../shared/sessionTraceRuntime.js');
  } catch (err) {
    process.stderr.write(`[LTR:warn] vitest trace: could not load the trace runtime — ${err && err.message}\n`);
    return undefined;
  }
})();

/** The test file this setup runs for. */
function currentTestFile() {
  try {
    const p = expect.getState().testPath;
    if (p) { return p; }
  } catch (_) { /* no state yet */ }
  const worker = globalThis.__vitest_worker__;
  return (worker && (worker.filepath || (worker.current && worker.current.file && worker.current.file.filepath))) || undefined;
}

/** "Outer Inner adds" — suites (not the file) and the test, unnamed suites skipped. */
function fullName(task) {
  const names = [];
  for (let t = task; t; t = t.suite) {
    if (t.type === 'suite' && (t.filepath || t === t.file)) { break; }
    if (t.name) { names.unshift(t.name); }
  }
  return names.join(' ');
}

/**
 * Tests that serialise a function — `page.evaluate(fn)`, a worker or sandbox
 * built from `fn.toString()` — see the code they wrote: toString() returns
 * the source without the trace calls. A Proxy keeps
 * `Function.prototype.toString` itself looking native.
 */
function patchToString() {
  let withoutTrace;
  try { ({ withoutTrace } = require_('./vitestTraceTransform.js')); } catch (_) { return; }
  const proto = Function.prototype;
  if (proto.toString.__ltr) { return; }
  const native = proto.toString;
  const patched = new Proxy(native, {
    apply(target, thisArg, args) {
      return withoutTrace(Reflect.apply(target, thisArg, args));
    },
    get(target, key, receiver) {
      return key === '__ltr' ? true : Reflect.get(target, key, receiver);
    },
  });
  try {
    Object.defineProperty(proto, 'toString', { value: patched, writable: true, configurable: true, enumerable: false });
  } catch (_) { /* frozen intrinsics: serialised functions keep the calls */ }
}

if (strace && strace.beginTest) {
  // Instrumented modules of this worker (also in a vm pool's own context) find it here.
  globalThis.__strace = strace;
  patchToString();
  let file = currentTestFile() || '<unknown>';
  strace.fileSeen(file);
  strace.beginFile(file);
  // Hook callbacks declare no parameters and read `arguments`: Vitest parses
  // a hook's first parameter for fixtures (`test.extend`) and rejects anything
  // but a destructuring pattern.
  beforeAll(function () {
    const suite = arguments[0];
    const fp = suite && (suite.filepath || (suite.file && suite.file.filepath));
    if (fp && fp !== file) { file = fp; strace.fileSeen(fp); }
    strace.endTest(file); // opens the 'hook' context
  });
  beforeEach(function () {
    const ctx = arguments[0];
    strace.beginTest((ctx && ctx.task && fullName(ctx.task)) || '<unknown>', file);
  });
  afterEach(() => {
    strace.endTest(file);
  });
  afterAll(() => {
    strace.finish();
  });
}
