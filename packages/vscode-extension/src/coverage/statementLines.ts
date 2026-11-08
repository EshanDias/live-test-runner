import type { Manifest } from './types';

/**
 * The lines (1-based) each statement of a manifest covers in the editor. A
 * statement with no other statement inside it covers every line it spans (a
 * `return {` over four lines, a call split over lines); one that holds others
 * (`const f = () => { … }` around a function body) only its first line —
 * otherwise a function that never ran would look green.
 *
 * Statements nest or are apart (never overlap), so after sorting by start a
 * statement holds another exactly when the next one starts before it ends.
 */
export function statementLines(manifest: Pick<Manifest, 'statements'>): Map<number, string[]> {
  const list = Object.entries(manifest.statements).sort(([, a], [, b]) =>
    a.start.line - b.start.line || a.start.col - b.start.col || b.end.line - a.end.line || b.end.col - a.end.col);
  const byLine = new Map<number, string[]>();
  const add = (line: number, id: string) => {
    const ids = byLine.get(line);
    if (ids) { ids.push(id); } else { byLine.set(line, [id]); }
  };
  for (let i = 0; i < list.length; i++) {
    const [id, loc] = list[i];
    const next = list[i + 1]?.[1];
    const holdsAnother = !!next && (next.start.line < loc.end.line || (next.start.line === loc.end.line && next.start.col < loc.end.col));
    const last = holdsAnother ? loc.start.line : Math.max(loc.start.line, loc.end.line);
    for (let line = loc.start.line; line <= last; line++) { add(line, id); }
  }
  return byLine;
}
