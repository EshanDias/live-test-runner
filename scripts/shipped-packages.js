'use strict';
/**
 * Third-party code that ships inside the extension, and where it runs.
 * `extension`: VS Code's own Node. `user`: the user's test process, on their Node.
 * Every package esbuild.js copies or bundles must be listed (support-floor.js
 * checks it); security-audit.js holds these to a stricter bar than dev tooling.
 */
module.exports = {
  '@babel/parser': ['extension', 'user'], // out/vendor/babel-parser.js (test listing, the Vitest trace)
  picomatch: ['extension'],               // bundled into out/extension.js
};
