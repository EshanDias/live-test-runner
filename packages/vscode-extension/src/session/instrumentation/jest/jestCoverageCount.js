'use strict';
/**
 * jestCoverageCount.js — counts source files no test loads exactly as
 * `jest --coverage` counts them (jestCoverage.countUntested: Jest's own
 * generateEmptyCoverage with the project's resolved config), in a child process:
 *   node jestCoverageCount.js <request.json>
 * request: { rootDir, files, resolvedConfig, cacheDirectory, provider, out } → `out`: istanbul coverage map.
 */
const fs = require('fs');
const { countUntested } = require('./jestCoverage.js');

(async () => {
  const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  fs.writeFileSync(req.out, JSON.stringify(await countUntested(req)));
})().catch((err) => {
  process.stderr.write(`[LTR:debug] jest coverage count: ${String(err && (err.stack || err.message)).replace(/\s*\r?\n\s*/g, ' ↵ ')}\n`);
  process.exitCode = 1;
});
