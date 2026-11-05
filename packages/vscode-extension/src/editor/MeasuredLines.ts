import * as fs from 'fs';
import { invertMatch, keptShare, matchLines, splitLines } from './lineMatch';

/** Below this share of the measured lines still in place, the whole file shows no bars. */
const MIN_KEPT_SHARE = 0.5;

/** What MeasuredLines needs from a text document. */
export interface LineDocument {
  readonly uri: { readonly fsPath: string };
  readonly version: number;
  getText(): string;
}

/** Converts between the editor's current lines and the lines coverage was measured on (0-based; -1 = edited or new). */
export interface LineMapping {
  toMeasured(line: number): number;
  toCurrent(line: number): number;
}

const SAME: LineMapping = { toMeasured: (l) => l, toCurrent: (l) => l };

/**
 * Keeps the coverage bars and hover on the right lines while the user edits.
 * Remembers each measurement's file text (read from disk the first time the
 * measurement is seen) and matches the editor's current text against it.
 */
export class MeasuredLines {
  /** Keyed by a measurement's identity (its counters object): the file's lines when it was measured. */
  private readonly _measured = new WeakMap<object, string[]>();
  private readonly _cache = new Map<string, { version: number; measurement: object; mapping: LineMapping }>();

  constructor(private readonly _read: (filePath: string) => string = (p) => fs.readFileSync(p, 'utf8')) {}

  /**
   * The mapping for `doc` against `measurement` (an object that stays the same
   * for one measurement and changes with the next — the entry's counters).
   */
  mappingFor(doc: LineDocument, measurement: object): LineMapping {
    const filePath = doc.uri.fsPath;
    const cached = this._cache.get(filePath);
    if (cached && cached.version === doc.version && cached.measurement === measurement) { return cached.mapping; }

    let measured = this._measured.get(measurement);
    if (!measured) {
      let text: string;
      try { text = this._read(filePath); } catch { text = doc.getText(); }
      measured = splitLines(text);
      this._measured.set(measurement, measured);
    }

    const current = splitLines(doc.getText());
    let mapping = SAME;
    if (!sameLines(measured, current)) {
      const toMeasured = matchLines(measured, current);
      const toCurrent = invertMatch(toMeasured, measured.length);
      // Most of the file changed: no bars at all until it is saved and measured again.
      if (keptShare(measured, toCurrent) < MIN_KEPT_SHARE) { toMeasured.fill(-1); toCurrent.fill(-1); }
      mapping = {
        toMeasured: (l) => (l >= 0 && l < toMeasured.length ? toMeasured[l] : -1),
        toCurrent: (l) => (l >= 0 && l < toCurrent.length ? toCurrent[l] : -1),
      };
    }
    this._cache.set(filePath, { version: doc.version, measurement, mapping });
    return mapping;
  }

  /** The document was closed: drop its cached mapping. */
  forget(filePath: string): void {
    this._cache.delete(filePath);
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { return false; }
  }
  return true;
}
