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
const BLOCK_OPEN = /[{([]\s*$/;                              // line ending with open bracket
const ASSIGN_VAR = /^\s*(?:const|let|var)\s+(\w+)\s*=/;     // const/let/var x =
const REASSIGN   = /^\s*(\w+)\s*(?:[+\-*/%&|^]=|=)(?!=)/;  // x = / x += etc (not ==)

/**
 * Find and invoke the first matching transformer from the project config, excluding
 * ourselves. Returns the transpiled source code, or the original code on failure.
 */
function chainTransform(sourceCode, sourcePath, options) {
  if (!options || !options.config) { return sourceCode; }

  // Jest passes config.transform as an array of [pattern, moduleName, transformerOptions?]
  // tuples (Jest 27+). Older Jest may pass it as a plain object — normalise.
  let transforms = options.config.transform;
  if (!Array.isArray(transforms)) {
    transforms = Object.entries(transforms || {}).map(([p, v]) =>
      Array.isArray(v) ? [p, ...v] : [p, v],
    );
  }

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
      // If chaining fails (e.g. ts-jest unavailable), fall through to raw source
    }
    break;
  }

  return sourceCode;
}

module.exports = {
  process(sourceCode, sourcePath, options) {
    // 1. Transpile TypeScript / JSX via the project's existing transformer
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);

    const lines = transpiledCode.split('\n');
    const outLines = [];
    let stepId = 0;

    // 2. Prepend the runtime so __trace is available in the test file scope
    outLines.push(`require(${JSON.stringify(RUNTIME_PATH)});`);

    for (let i = 0; i < lines.length; i++) {
      const raw  = lines[i];
      const trim = raw.trim();

      // Always emit the original (transpiled) line first
      outLines.push(raw);

      // Skip blank lines, comment lines, and lines ending with an open bracket
      if (!trim || SKIP_LINE.test(trim) || BLOCK_OPEN.test(trim)) {
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
