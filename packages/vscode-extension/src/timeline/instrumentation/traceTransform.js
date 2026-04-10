'use strict';
/**
 * traceTransform.js — custom Jest transform that injects __trace calls.
 *
 * Implements Jest's synchronous transform interface:
 *   { process(sourceCode, sourcePath, options): { code: string } }
 *
 * Strategy:
 *  1. Chain through the project's existing transformer (babel-jest / ts-jest) so
 *     TypeScript and JSX files are transpiled to plain JS first.
 *  2. Inject __trace.step() and __trace.var() calls via regex into the transpiled JS.
 *  3. Prepend a require() of traceRuntime.js so __trace is available at runtime.
 *
 * Only the target test file is transformed — see JestInstrumentedRunner.run().
 * traceRuntime.js patches console.* to emit LOG events (no transform needed).
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'traceRuntime.js');

// Patterns for lines we want to instrument (applied to the already-transpiled JS)
const SKIP_LINE  = /^\s*(\/\/|\/\*|\*|'use strict'|"use strict"|import\s|export\s)/;
const ASSIGN_VAR = /^\s*(?:const|let|var)\s+(\w+)\s*=/;     // const/let/var x =
const REASSIGN   = /^\s*(\w+)\s*(?:[+\-*/%&|^]=|=)(?!=)/;  // x = / x += etc (not ==)

/**
 * Find and invoke the first matching transformer from the project config, excluding
 * ourselves. Returns the transpiled source code, or the original code on failure.
 */
function chainTransform(sourceCode, sourcePath, options) {
  if (!options || !options.config) { return sourceCode; }

  // Jest passes config.transform to the transformer's process() as an array of
  // [pattern, moduleName, transformerOptions?] tuples (Jest 27+ internal format).
  // Normalise in case an older Jest passes a plain object.
  let transforms = options.config.transform;
  if (!Array.isArray(transforms)) {
    transforms = Object.entries(transforms || {}).map(([p, v]) =>
      Array.isArray(v) ? [p, ...v] : [p, v],
    );
  }
  process.stderr.write(`[LTR-TRANSFORM] transform chain entries: ${transforms.length}\n`);

  for (const entry of transforms) {
    const [pattern, moduleName] = entry;
    // Skip ourselves to avoid infinite recursion
    if (moduleName === __filename) { continue; }
    if (!new RegExp(pattern).test(sourcePath)) { continue; }

    try {
      const transformer = require(moduleName);
      if (typeof transformer.process !== 'function') { continue; }
      // Pass a reduced config so the downstream transformer doesn't loop back through us
      const downstreamOptions = {
        ...options,
        config: { ...options.config, transform: transforms.filter(e => e !== entry) },
      };
      const result = transformer.process(sourceCode, sourcePath, downstreamOptions);
      if (result && typeof result.code === 'string') {
        return result.code;
      }
      if (typeof result === 'string') {
        return result;
      }
    } catch (_e) {
      // If chaining fails, fall through to the babel-jest fallback below
    }
    break;
  }

  // Fallback: invoke babel-jest from the project's node_modules with an explicit
  // preset so it transpiles ES-module syntax even when the project has no
  // babel.config.js (e.g. CRA projects where babel config lives inside react-scripts).
  const rootDir = options && options.config && options.config.rootDir;
  if (rootDir) {
    const babelJestPath = path.join(rootDir, 'node_modules', 'babel-jest');
    try {
      const babelJest = require(babelJestPath);
      const createTransformer = babelJest.createTransformer
        || (babelJest.default && babelJest.default.createTransformer);

      if (createTransformer) {
        // Pick the best available preset from the project's node_modules.
        // react-app covers CRA; @babel/preset-env covers everything else.
        let presets;
        const reactAppPreset = path.join(rootDir, 'node_modules', 'babel-preset-react-app');
        const presetEnv      = path.join(rootDir, 'node_modules', '@babel', 'preset-env');
        const presetReact    = path.join(rootDir, 'node_modules', '@babel', 'preset-react');

        try {
          require(reactAppPreset);
          // CRA — use react-app preset (handles JSX + modern JS + TS)
          presets = [[reactAppPreset, { runtime: 'automatic' }]];
        } catch (_) {
          // Generic — combine preset-env (ES-modules → CJS) + react if present
          const ps = [[presetEnv, { targets: { node: 'current' } }]];
          try { require(presetReact); ps.push([presetReact, {}]); } catch (_) {}
          presets = ps;
        }

        const transformer = createTransformer({ configFile: false, presets });
        process.stderr.write(`[LTR-TRANSFORM] babel-jest fallback with presets: ${JSON.stringify(presets.map(p => p[0]))}\n`);
        const result = transformer.process(sourceCode, sourcePath, options);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      process.stderr.write(`[LTR-TRANSFORM] babel-jest fallback failed: ${_e.message}\n`);
    }
  }

  return sourceCode;
}

module.exports = {
  process(sourceCode, sourcePath, options) {
    // DEBUG — remove once confirmed working
    process.stderr.write(`[LTR-TRANSFORM] called for: ${sourcePath}\n`);
    process.stderr.write(`[LTR-TRANSFORM] TRACE_OUTPUT_FILE: ${process.env.TRACE_OUTPUT_FILE || '(not set)'}\n`);

    // 1. Transpile TypeScript / JSX via the project's existing transformer
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
    process.stderr.write(`[LTR-TRANSFORM] chain result length: ${transpiledCode.length}\n`);

    const lines = transpiledCode.split('\n');
    const outLines = [];
    let stepId = 0;
    let depth = 0; // bracket depth — only inject when depth === 0 (statement complete)

    // 2. Prepend the runtime so __trace is available in the test file scope
    outLines.push(`require(${JSON.stringify(RUNTIME_PATH)});`);

    for (let i = 0; i < lines.length; i++) {
      const raw  = lines[i];
      const trim = raw.trim();

      // Always emit the original (transpiled) line first
      outLines.push(raw);

      // Track bracket depth across the line so we know if we're mid-expression.
      // We skip string/comment parsing (good enough for babel-transpiled output).
      for (const ch of raw) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; }
        else if (ch === '}' || ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); }
      }

      // Skip blank lines, comment/import/export lines, and any line that leaves
      // us inside an open expression (depth > 0 means multi-line statement in progress).
      if (depth > 0 || !trim || SKIP_LINE.test(trim)) {
        continue;
      }

      // Inject a STEP trace after the line (so the line has already run)
      stepId++;
      const lineNo = i + 1;
      outLines.push(
        `__trace.step(${stepId}, ${lineNo}, ${JSON.stringify(sourcePath)}, ` +
        `(typeof __currentTestName !== 'undefined' ? __currentTestName : undefined));`,
      );

      // Inject a VAR trace if the line looks like an assignment
      let varName = null;
      const constMatch = ASSIGN_VAR.exec(trim);
      if (constMatch) {
        varName = constMatch[1];
      } else {
        const reassignMatch = REASSIGN.exec(trim);
        if (reassignMatch) { varName = reassignMatch[1]; }
      }

      if (varName) {
        outLines.push(
          `try { __trace.var(${stepId}, ${JSON.stringify(varName)}, ${varName}); } catch(_e) {}`,
        );
      }
    }

    return { code: outLines.join('\n') };
  },
};
