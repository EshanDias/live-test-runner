let tests = 0;

export function resetCounters() {
  tests = tests || 0;
}

export function countTest() {
  tests += 1;
}
