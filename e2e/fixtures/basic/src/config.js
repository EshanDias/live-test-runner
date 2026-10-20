// Only module-level code: it runs when a test file is loaded, never inside a
// test, so no test is traced to it. Saving it reruns through
// jest --findRelatedTests instead of the trace.
module.exports = { greeting: 'hello' };
