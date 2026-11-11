'use strict';
/** Coverage stays truthful while the session runs — pytest, per test file from its per-test contexts (checks: e2e/lib/coverageLive.js). */
const live = require('../lib/coverageLive');

module.exports = {
  workspace: 'fixture:coverage-live-pytest',
  timeoutMs: 5 * 60_000,
  run: (ctx) => live.run(ctx, {
    aTest: 'tests/test_a.py', aSrc: 'src/pkg/a.py', bSrc: 'src/pkg/b.py', cSrc: 'src/pkg/c.py', eSrc: 'src/pkg/e.py', otherTest: 'tests/test_other.py',
    removeTwo: (s) => s.replace(/def test_two\(\):\n.*\n\n\n/, ''),
    stopCallingHelper: (s) => s.replace('return helper(x)', 'return x + 1'),
    newFile: {
      path: 'src/pkg/d.py',
      content: 'def brand_new():\n    return "d"\n',
      more: '\n\ndef another():\n    return "dd"\n',
    },
    process: /^\[pytest#\d+\] > /,
    byName: /::/,
  }),
};
