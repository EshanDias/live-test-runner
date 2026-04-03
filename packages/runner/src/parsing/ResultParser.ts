import * as path from "path";
import {
  JestJsonResult,
  JestFileResult,
  JestTestCaseResult,
  JestConsoleEntry,
} from "../types";

/**
 * Parses the JSON output produced by `jest --json --outputFile=<file>` into
 * our internal JestJsonResult structure.
 *
 * Also handles the console.log fallback: react-scripts omits the `console`
 * array from its JSON output, so we parse it from stderr instead.
 */
export class ResultParser {
  /**
   * Parse raw Jest JSON string into a JestJsonResult.
   *
   * @param passed   Whether the process exited with code 0.
   * @param raw      The raw JSON string (from outputFile or stdout).
   * @param stderr   The full stderr output (used for console fallback + error messages).
   */
  parse(passed: boolean, raw: string, stderr: string): JestJsonResult {
    try {
      const json = JSON.parse(raw);
      const fileResults: JestFileResult[] = (json.testResults ?? []).map(
        (fr: any): JestFileResult => {
          const testCases = (fr.testResults ?? fr.assertionResults ?? []).map(
            (tc: any): JestTestCaseResult => ({
              ancestorTitles: tc.ancestorTitles ?? [],
              title: tc.title ?? "",
              fullName: tc.fullName ?? "",
              status: tc.status ?? "failed",
              duration: tc.duration,
              failureMessages: this.stripStackTraces(tc.failureMessages) ?? [],
            }),
          );

          const fileDuration = this.computeFileDuration(testCases, fr);

          const consoleOutput: JestConsoleEntry[] = (fr.console ?? []).map(
            (c: any): JestConsoleEntry => ({
              message: String(c.message ?? ""),
              type: String(c.type ?? "log"),
              origin: String(c.origin ?? ""),
            }),
          );

          return {
            testFilePath: fr.testFilePath ?? "",
            status: fr.status === "passed" ? "passed" : "failed",
            failureMessage: fr.failureMessage || undefined,
            testCases,
            consoleOutput,
            duration: fileDuration > 0 ? fileDuration : undefined,
          };
        },
      );

      // Jest ≤27 omits the `console` array from JSON (react-scripts included).
      // Fall back to parsing the human-readable console blocks from stderr.
      //
      // Single-file run: attribute everything to the one file.
      // Multi-file run: attribute each stderr entry to the file whose path
      //   appears in the entry's origin field. Entries with no matching file
      //   are attached to the first file with empty console output (best effort).
      const anyMissingConsole = fileResults.some(fr => fr.consoleOutput.length === 0);
      if (anyMissingConsole) {
        const stderrEntries = this.parseConsoleFromStderr(stderr);
        if (stderrEntries.length > 0) {
          if (fileResults.length === 1) {
            fileResults[0].consoleOutput = stderrEntries;
          } else {
            // Build a quick lookup: normalised file path → FileResult index
            const pathIndex = new Map<string, number>();
            fileResults.forEach((fr, idx) => {
              // Index by full path and basename so origin substrings match
              pathIndex.set(fr.testFilePath, idx);
              pathIndex.set(fr.testFilePath.replace(/\\/g, '/'), idx);
            });

            const buckets: JestConsoleEntry[][] = fileResults.map(() => []);
            let fallbackIdx = fileResults.findIndex(fr => fr.consoleOutput.length === 0);

            for (const entry of stderrEntries) {
              let matched = false;
              for (const [fp, idx] of pathIndex) {
                if (entry.origin.includes(fp) || fp.includes(entry.origin.split(':')[0])) {
                  buckets[idx].push(entry);
                  matched = true;
                  break;
                }
              }
              if (!matched && fallbackIdx >= 0) {
                buckets[fallbackIdx].push(entry);
              }
            }

            fileResults.forEach((fr, idx) => {
              if (fr.consoleOutput.length === 0 && buckets[idx].length > 0) {
                fr.consoleOutput = buckets[idx];
              }
            });
          }
        }
      }

      return {
        passed,
        numPassedTests: json.numPassedTests ?? 0,
        numFailedTests: json.numFailedTests ?? 0,
        numPendingTests: json.numPendingTests ?? 0,
        fileResults,
        errors: passed ? [] : [stderr || "Tests failed"],
      };
    } catch {
      return this.empty(false, [
        stderr || raw || "Jest failed to produce JSON output",
      ]);
    }
  }

  /** Parse `--listTests` output into an array of absolute file paths. */
  parseListTestsOutput(output: string): string[] {
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.includes("/") || l.includes(path.sep));
  }

  /** Build an empty result with the given pass/fail state and error messages. */
  empty(passed: boolean, errors: string[]): JestJsonResult {
    return {
      passed,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      fileResults: [],
      errors,
    };
  }

  /** Merge multiple JestJsonResults into one (used for chunked multi-file runs). */
  merge(results: JestJsonResult[]): JestJsonResult {
    return {
      passed: results.every((r) => r.passed),
      numPassedTests: results.reduce((s, r) => s + r.numPassedTests, 0),
      numFailedTests: results.reduce((s, r) => s + r.numFailedTests, 0),
      numPendingTests: results.reduce((s, r) => s + r.numPendingTests, 0),
      fileResults: results.flatMap((r) => r.fileResults),
      errors: results.flatMap((r) => r.errors),
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Strips stack-trace lines from failure messages, keeping only the assertion
   * error text. Stack traces are noisy in the UI and not actionable there.
   */
  private stripStackTraces(failureMessages: string[] = []): string[] {
    try {
      return failureMessages.map((msg) => {
        const lines = msg.split("\n");
        const stackIndex = lines.findIndex((l) => l.trim().startsWith("at "));
        return lines
          .slice(0, stackIndex === -1 ? lines.length : stackIndex)
          .join("\n");
      });
    } catch {
      return [];
    }
  }

  private computeFileDuration(
    testCases: JestTestCaseResult[],
    fr: any,
  ): number {
    const fromCases = testCases.reduce(
      (sum, tc) => sum + (tc.duration ?? 0),
      0,
    );
    if (fromCases > 0) return fromCases;
    if (fr.endTime && fr.startTime) return fr.endTime - fr.startTime;
    return 0;
  }

  /**
   * Extracts console.log/warn/error/info/debug blocks from Jest's human-readable stderr.
   *
   * Handles two formats emitted by different Jest versions:
   *
   *   Jest 27+ (type on its own line):
   *     "  console.log\n    <message lines>\n\n      at origin (file:line)\n"
   *
   *   Jest 26 / some CRA builds (origin on the same line as type):
   *     "  console.log path/to/file.js:10:5\n    <message lines>\n"
   */
  parseConsoleFromStderr(stderr: string): JestConsoleEntry[] {
    const entries: JestConsoleEntry[] = [];
    const lines = stderr.split(/\r?\n/);
    let i = 0;

    // Matches both "  console.log" and "  console.log src/file.js:8"
    const HEADER_RE = /^\s+console\.(log|error|warn|info|debug)(?:\s+(.+))?$/;
    const NEXT_HEADER_RE = /^\s+console\.(log|error|warn|info|debug)/;

    while (i < lines.length) {
      const header = lines[i].match(HEADER_RE);
      if (!header) {
        i++;
        continue;
      }

      const type = header[1];
      // Jest 26 puts the origin (file:line) on the header line itself
      let origin = header[2]?.trim() ?? "";
      i++;

      const msgLines: string[] = [];

      while (i < lines.length) {
        if (NEXT_HEADER_RE.test(lines[i])) break;
        if (/^\s+at\s/.test(lines[i])) {
          if (!origin) origin = lines[i].trim();
          i++;
          while (i < lines.length && /^\s+at\s/.test(lines[i])) i++;
          break;
        }
        msgLines.push(lines[i]);
        i++;
      }

      while (msgLines.length > 0 && msgLines[0].trim() === "") msgLines.shift();
      while (msgLines.length > 0 && msgLines[msgLines.length - 1].trim() === "")
        msgLines.pop();

      if (msgLines.length > 0) {
        entries.push({
          message: msgLines.map((l) => l.replace(/^\s{4}/, "")).join("\n"),
          type,
          origin,
        });
      }
    }

    return entries;
  }
}
