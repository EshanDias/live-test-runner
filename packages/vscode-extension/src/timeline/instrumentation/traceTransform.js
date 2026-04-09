'use strict';
/**
 * traceTransform.js — custom Jest transform that injects __trace calls.
 *
 * Implements Jest's synchronous transform interface:
 *   { process(sourceCode, sourcePath, options): { code: string } }
 *
 * Strategy (regex-based, no AST — MVP scope):
 *  - Before each non-blank, non-comment statement line: inject __trace.step(...)
 *  - After lines that look like `const/let/var x = ...` or `x = ...` (assignments):
 *    inject __trace.var(stepId, 'x', x)
 *  - Intercept console.log/warn/error/info calls on the injected runtime side
 *    (traceRuntime patches console — no transform needed)
 *
 * Only the target test file is transformed (Jest applies transforms per-file;
 * non-matching files use the identity transform or the project's own transform).
 *
 * The transform is added to the Jest config only for the specific file being
 * debugged — see JestInstrumentedRunner.run() in task 10.
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'traceRuntime.js');

// Patterns for lines we want to instrument
const SKIP_LINE  = /^\s*(\/\/|\/\*|\*|'use strict'|"use strict"|import\s|export\s)/;
const BLOCK_OPEN = /[{([]\s*$/;                 // line ending with open bracket — skip
const ASSIGN_VAR = /^\s*(?:const|let|var)\s+(\w+)\s*=/;  // const/let/var x =
const REASSIGN   = /^\s*(\w+)\s*(?:[+\-*/%&|^]=|=)(?!=)/; // x = / x += etc (not ==)

module.exports = {
  process(sourceCode, sourcePath) {
    const lines = sourceCode.split('\n');
    const outLines = [];
    let stepId = 0;

    // Prepend the runtime require so __trace is available in the test file scope.
    // Using require() is safe because Jest transforms run in Node.
    outLines.push(`require(${JSON.stringify(RUNTIME_PATH)});`);

    for (let i = 0; i < lines.length; i++) {
      const raw  = lines[i];
      const trim = raw.trim();

      // Always emit the original line first
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
        `(typeof __currentTestName !== 'undefined' ? __currentTestName : undefined));`
      );

      // Inject a VAR trace if the line is an assignment
      let varName = null;
      const constMatch = ASSIGN_VAR.exec(trim);
      if (constMatch) {
        varName = constMatch[1];
      } else {
        const reassignMatch = REASSIGN.exec(trim);
        if (reassignMatch) { varName = reassignMatch[1]; }
      }

      if (varName) {
        // Wrap in try/catch — variable may not be in scope after the statement
        outLines.push(
          `try { __trace.var(${stepId}, ${JSON.stringify(varName)}, ${varName}); } catch(_e) {}`
        );
      }
    }

    return { code: outLines.join('\n') };
  },
};
