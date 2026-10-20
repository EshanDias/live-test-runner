'use strict';
/**
 * Minimal Jest transformer for the unit tests: compiles TypeScript (and JS)
 * with esbuild, so tests import `src/` directly — no build step, no ts-jest.
 */
const { transformSync } = require('esbuild');
const crypto = require('crypto');

module.exports = {
  process(source, filename) {
    const { code, map } = transformSync(source, {
      loader: /\.tsx?$/.test(filename) ? 'ts' : 'js',
      format: 'cjs',
      target: 'node16',
      sourcemap: 'external',
      sourcefile: filename,
    });
    return { code, map };
  },
  getCacheKey(source, filename) {
    return crypto.createHash('sha1').update(source).update('\0').update(filename).update('\0esbuild-1').digest('hex');
  },
};
