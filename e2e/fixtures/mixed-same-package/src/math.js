// Loaded by Jest tests (add) and Vitest tests (mul): its coverage merges both.
function add(a, b) {
  return a + b;
}

function mul(a, b) {
  return a * b;
}

function neverCalled() {
  return 'nobody tests this';
}

module.exports = { add, mul, neverCalled };
