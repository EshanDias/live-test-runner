/**
 * Trace records → ExecutionTraceStore, for every framework.
 *
 * The test process writes JSON lines (shared/sessionTraceRuntime.js, see
 * docs/architecture.md → Session instrumentation protocol):
 *   T  hits of one test         { type, tf, tn, fh: { srcFile: lines[] } }
 *   H  hits outside a test      { type, tf, hk, fh }  ('file' = module load, else a hook)
 *   F  the setup file ran       { type, tf }          (Vitest: the file is traced)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fromRunnerPath } from '@live-test-runner/runner';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';

interface TestHitRecord { type: 'T'; tf: string; tn: string; fh: { [srcFile: string]: number[] } }
interface HookHitRecord {
  type: 'H';
  tf: string;
  /** 'file' = module-level code run while the test file loaded; otherwise a hook. */
  hk?: string;
  fh: { [srcFile: string]: number[] };
}
interface FileSeenRecord { type: 'F'; tf: string }
type TraceRecord = TestHitRecord | HookHitRecord | FileSeenRecord;

export interface TraceSummary {
  /** Test records applied. */
  tests: number;
  /** Test files with at least one test record. */
  files: number;
  /** Test files whose setup reported in (F records), in the caller's keys. */
  seen: Set<string>;
}

/** Reads trace files (missing ones are skipped) and returns their lines. */
export function readTraceLines(files: string[]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) { if (l.trim()) { lines.push(l); } }
  }
  return lines;
}

/** A batch's per-worker trace files: `<base>.<pid>-<thread>` (see sessionTraceRuntime.js). */
export function workerTraceFiles(base: string): string[] {
  const dir = path.dirname(base);
  const prefix = `${path.basename(base)}.`;
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Applies trace lines to the store: covered lines, line → tests, and
 * source file → test file → suite → tests (what a source-file save reruns).
 * @param toKey maps the runner's spelling of a test-file path to the store's key
 */
export function applyTraceRecords(
  lines: string[],
  traceStore: ExecutionTraceStore,
  toKey: (p: string) => string,
): TraceSummary {
  const testsByFile = new Map<string, TestHitRecord[]>();
  const hooksByFile = new Map<string, HookHitRecord[]>();
  const seen = new Set<string>();

  for (const line of lines) {
    let rec: TraceRecord;
    try { rec = JSON.parse(line) as TraceRecord; } catch { continue; }
    if (!rec || !rec.tf) { continue; }
    rec.tf = toKey(rec.tf);
    if (rec.type === 'T') {
      const bucket = testsByFile.get(rec.tf) ?? [];
      bucket.push(rec);
      testsByFile.set(rec.tf, bucket);
    } else if (rec.type === 'H') {
      const bucket = hooksByFile.get(rec.tf) ?? [];
      bucket.push(rec);
      hooksByFile.set(rec.tf, bucket);
    } else if (rec.type === 'F') {
      seen.add(rec.tf);
    }
  }

  // Coverage index — aggregate all hit lines across every test + hook.
  for (const recs of [...testsByFile.values(), ...hooksByFile.values()]) {
    for (const rec of recs) {
      for (const [srcFile, linesArr] of Object.entries(rec.fh)) {
        traceStore.addCoveredLines(normPath(srcFile), linesArr);
      }
    }
  }

  // Line → test reverse index — for each test, record which lines it hit in each source file.
  for (const [testFilePath, testRecs] of testsByFile) {
    const fileLineMap = new Map<string, Map<number, string[]>>();
    for (const rec of testRecs) {
      for (const [srcFile, linesArr] of Object.entries(rec.fh)) {
        const normSrc = normPath(srcFile);
        if (normSrc === testFilePath) { continue; }
        let lineMap = fileLineMap.get(normSrc);
        if (!lineMap) {
          lineMap = new Map();
          fileLineMap.set(normSrc, lineMap);
        }
        for (const line of linesArr) {
          const names = lineMap.get(line) ?? [];
          if (!names.includes(rec.tn)) { names.push(rec.tn); }
          lineMap.set(line, names);
        }
      }
    }
    for (const [srcFile, lineMap] of fileLineMap) {
      traceStore.mergeLineToTests(srcFile, testFilePath, lineMap);
    }
  }

  // sourceToTests index — for each test file, map source files to the tests that hit them.
  for (const [testFilePath, testRecs] of testsByFile) {
    const testNames = testRecs.map((r) => r.tn);

    // Hooks (beforeAll/afterAll) affect every test in the file. Module-level
    // code run at import does not make every test "use" that module — it
    // counts for coverage only, or every save would rerun whole files.
    const hookFiles = new Set<string>();
    for (const hookRec of hooksByFile.get(testFilePath) ?? []) {
      if (hookRec.hk === 'file') { continue; }
      for (const srcFile of Object.keys(hookRec.fh)) {
        if (normPath(srcFile) !== testFilePath) { hookFiles.add(normPath(srcFile)); }
      }
    }

    const perTestFiles = new Map<string, string[]>();
    for (const rec of testRecs) {
      const files = perTestFiles.get(rec.tn) ?? [];
      for (const srcFile of Object.keys(rec.fh)) {
        const n = normPath(srcFile);
        if (n !== testFilePath && !files.includes(n)) { files.push(n); }
      }
      perTestFiles.set(rec.tn, files);
    }

    const touchedSourceFiles = new Set<string>(hookFiles);
    for (const files of perTestFiles.values()) {
      for (const f of files) { touchedSourceFiles.add(f); }
    }

    for (const sourceFile of touchedSourceFiles) {
      const touchingTests: string[] = [];
      for (const tn of testNames) {
        const files = perTestFiles.get(tn) ?? [];
        if ((files.includes(sourceFile) || hookFiles.has(sourceFile)) && !touchingTests.includes(tn)) {
          touchingTests.push(tn);
        }
      }

      const sourceMap: {
        [suite: string]: { isSharedVars: boolean; sharedVarNames: string[]; testCases: string[] };
      } = {};
      for (const tn of touchingTests) {
        const suiteName = extractSuiteName(tn);
        if (!sourceMap[suiteName]) {
          sourceMap[suiteName] = { isSharedVars: false, sharedVarNames: [], testCases: [] };
        }
        if (!sourceMap[suiteName].testCases.includes(tn)) {
          sourceMap[suiteName].testCases.push(tn);
        }
      }

      const existing = traceStore.getSourceMapping(sourceFile) ?? {};
      const existingForFile = existing[testFilePath] ?? {};
      const mergedForFile = { ...existingForFile };
      for (const [suiteName, suiteInfo] of Object.entries(sourceMap)) {
        if (mergedForFile[suiteName]) {
          const existingCases = mergedForFile[suiteName].testCases;
          const newCases = suiteInfo.testCases.filter((t) => !existingCases.includes(t));
          mergedForFile[suiteName] = {
            ...mergedForFile[suiteName],
            testCases: [...existingCases, ...newCases],
          };
        } else {
          mergedForFile[suiteName] = suiteInfo;
        }
      }

      traceStore.setSourceMapping(sourceFile, {
        ...existing,
        [testFilePath]: mergedForFile,
      });
    }
  }

  const tests = Array.from(testsByFile.values()).reduce((n, recs) => n + recs.length, 0);
  return { tests, files: testsByFile.size, seen };
}

function extractSuiteName(fullTestName: string): string {
  const lastSep = fullTestName.lastIndexOf(' > ');
  return lastSep !== -1 ? fullTestName.slice(0, lastSep) : fullTestName;
}

/** A source path from the runner in the editor's spelling (symlinks, drive-letter case). */
export function normPath(filePath: string): string {
  return fromRunnerPath(filePath).replace(/^[A-Z]:/, (m) => m.toLowerCase());
}
