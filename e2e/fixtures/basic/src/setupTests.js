// Learnt from copy-requisition: a project setup file with beforeEach /
// afterEach hooks. It is instrumented like any source file, and its hooks once
// erased the running test's trace (no smart reruns, no covering tests).
const { resetState, markDirty } = require('./testState');

beforeEach(() => {
  resetState();
});

afterEach(() => {
  markDirty();
});
