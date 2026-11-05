/**
 * Matches the lines of an edited file to the lines it had when its coverage
 * was measured, so coverage bars and hovers stay on the right lines while the
 * user edits. No VS Code dependency.
 *
 * Rules (owner, 2026-11-05) — a wrong bar is worse than no bar:
 *  - spacing inside or at the end of a line does not count as an edit, but
 *    the indentation does (code pasted into a new `if` has new coverage);
 *  - code that moved has no bar (nor the lines it moved across);
 *  - an edited or new line has no bar.
 */

/** Above this many cells (changed old lines × changed new lines) the changed middle is not matched line by line. */
const MAX_MIDDLE_CELLS = 2_000_000;

/**
 * A line as compared: its indentation exactly, then runs of spaces collapsed
 * and the end trimmed (`a  +  b ` and `a + b` are the same line, `  x` and `    x` are not).
 */
export function normalizeLine(line: string): string {
  const indent = /^\s*/.exec(line)![0];
  return indent + line.slice(indent.length).replace(/\s+/g, ' ').trimEnd();
}

/** A line distinctive enough to recognise as moved (not `}`, blank or a lone keyword). */
function isDistinctive(normalized: string): boolean {
  const text = normalized.trim();
  return text.length >= 4 && /\w/.test(text);
}

/**
 * For each current line, the measured line it is (0-based), or -1 when the
 * line is new, edited or moved. Unchanged lines at the start and end match
 * directly; the changed middle is matched by longest common subsequence.
 */
export function matchLines(measuredLines: readonly string[], currentLines: readonly string[]): Int32Array {
  const measured = measuredLines.map(normalizeLine);
  const current = currentLines.map(normalizeLine);
  const map = new Int32Array(current.length).fill(-1);

  let start = 0;
  const shortest = Math.min(measured.length, current.length);
  while (start < shortest && measured[start] === current[start]) {
    map[start] = start;
    start++;
  }

  let endM = measured.length;
  let endC = current.length;
  while (endM > start && endC > start && measured[endM - 1] === current[endC - 1]) {
    endM--;
    endC--;
    map[endC] = endM;
  }

  const n = endM - start;
  const m = endC - start;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_MIDDLE_CELLS) { return map; }

  // lcs[i][j] = longest common subsequence of measured[start+i..endM) and current[start+j..endC)
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = measured[start + i] === current[start + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (measured[start + i] === current[start + j]) {
      map[start + j] = start + i;
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  dropMovedCode(measured, current, map, start, endM, endC);
  return map;
}

/**
 * A move shows up as a line removed in one place and added in another. The
 * match keeps only one side of a move, so it cannot tell which code moved:
 * every line between the two places loses its match (no bar there).
 */
function dropMovedCode(measured: string[], current: string[], map: Int32Array, start: number, endM: number, endC: number): void {
  const matchedMeasured = new Set<number>();
  for (let c = start; c < endC; c++) { if (map[c] >= 0) { matchedMeasured.add(map[c]); } }

  const removed = new Map<string, number[]>(); // text → measured lines removed
  for (let k = start; k < endM; k++) {
    if (!matchedMeasured.has(k) && isDistinctive(measured[k])) {
      const list = removed.get(measured[k]) ?? [];
      list.push(k);
      removed.set(measured[k], list);
    }
  }
  if (removed.size === 0) { return; }

  // Where a removed measured line would be now: the current line of the next matched measured line.
  const currentOf = new Int32Array(endM + 1).fill(endC);
  for (let c = endC - 1; c >= start; c--) { if (map[c] >= 0) { currentOf[map[c]] = c; } }
  for (let k = endM - 1; k >= start; k--) { if (!matchedMeasured.has(k)) { currentOf[k] = currentOf[k + 1]; } }

  for (let c = start; c < endC; c++) {
    if (map[c] >= 0) { continue; }
    const from = removed.get(current[c]);
    if (!from) { continue; }
    for (const k of from) {
      const was = currentOf[k];
      const lo = Math.min(was, c);
      const hi = Math.max(was, c);
      for (let x = lo; x < hi && x < endC; x++) { map[x] = -1; }
    }
  }
}

/** The reverse of {@link matchLines}: for each measured line, the current line it is now, or -1. */
export function invertMatch(map: Int32Array, measuredLineCount: number): Int32Array {
  const inverse = new Int32Array(measuredLineCount).fill(-1);
  for (let cur = 0; cur < map.length; cur++) {
    const old = map[cur];
    if (old >= 0 && old < measuredLineCount) { inverse[old] = cur; }
  }
  return inverse;
}

/**
 * Share of the measured file's non-blank lines that are still there (0–1).
 * Below a half the file counts as rewritten and shows no bars until saved.
 */
export function keptShare(measuredLines: readonly string[], inverse: Int32Array): number {
  let total = 0;
  let kept = 0;
  for (let k = 0; k < measuredLines.length; k++) {
    if (measuredLines[k].trim() === '') { continue; }
    total++;
    if (inverse[k] >= 0) { kept++; }
  }
  return total === 0 ? 1 : kept / total;
}

/** Splits file text into lines the way the editor counts them. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}
