// An optional chain inside the call arguments of another optional chain used
// to crash instrumentation ("Container is falsy") and fail every test file
// importing this module.
function matchesSource(invoice, source) {
  return invoice?.SOURCE?.toLowerCase().includes(source?.toLowerCase());
}

module.exports = { matchesSource };
