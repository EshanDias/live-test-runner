'use strict';
/** Coverage stays truthful while the session runs — Jest (checks: e2e/lib/coverageLive.js). */
const live = require('../lib/coverageLive');

module.exports = {
  workspace: 'fixture:coverage-live',
  timeoutMs: 5 * 60_000,
  run: (ctx) => live.run(ctx, module.exports.spec),
  spec: {
    aTest: 'src/a.test.js', aSrc: 'src/a.js', bSrc: 'src/b.js', cSrc: 'src/c.js', eSrc: 'src/e.js', otherTest: 'src/other.test.js',
    removeTwo: (s) => s.replace(/test\('two'[\s\S]*?\n\}\);\n/, ''),
    shared: { src: 'src/s.js', test: 'src/s1.test.js', removeSecond: (s) => s.replace(/\ntest\('second'[\s\S]*?\n\}\);\n/, '') },
    stopCallingHelper: (s) => s.replace('return helper(x);', 'return x + 1;'),
    counter: { src: 'src/counter.js', test: 'src/counter.test.js', tests: 3 },
    newFile: {
      path: 'src/d.js',
      content: "function brandNew() {\n  return 'd';\n}\n\nmodule.exports = { brandNew };\n",
      more: "\nfunction another() {\n  return 'dd';\n}\n\nmodule.exports.another = another;\n",
    },
    framework: 'jest',
    process: /^\[jest#\d+\] > /,
    byName: /--testNamePattern/,
  },
};
