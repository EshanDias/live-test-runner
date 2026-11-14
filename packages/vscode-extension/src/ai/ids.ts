/**
 * Ids an AI assistant sees: the store's node ids with the machine part of
 * the path taken off — `src/math.test.js::Math utils::adds` — and file ids
 * as workspace-relative paths. Readable, short, stable within a session,
 * and they map straight back to store ids. In a multi-root workspace the
 * folder's name leads (`web/src/a.test.ts::…`).
 */
import * as path from 'path';

const SEP = '::';

export class IdCodec {
  constructor(private readonly _folders: () => string[]) {}

  /** A path as the assistant sees it: relative to its workspace folder, `/`-separated. */
  rel(absPath: string): string {
    const folders = this._folders();
    for (const f of folders) {
      const r = path.relative(f, absPath);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) {
        const posix = r.split(path.sep).join('/');
        return folders.length > 1 ? `${path.basename(f)}/${posix}` : posix;
      }
    }
    return absPath.split(path.sep).join('/');
  }

  /** A store id (file path, or node id starting with its file path) for the assistant. */
  encode(storeId: string, fileId: string): string {
    return storeId.startsWith(fileId) ? this.rel(fileId) + storeId.slice(fileId.length) : this.rel(storeId);
  }

  /**
   * The absolute spellings an id or path the assistant sent may stand for
   * (the caller checks which one the stores know). Accepts our ids,
   * workspace-relative or absolute paths, `\` separators and a leading `./`.
   */
  candidates(id: string): string[] {
    const cut = id.indexOf(SEP);
    const filePart = (cut >= 0 ? id.slice(0, cut) : id).trim().replace(/^\.[\\/]/, '');
    const rest = cut >= 0 ? id.slice(cut) : '';
    if (!filePart) { return []; }
    if (path.isAbsolute(filePart)) { return [path.normalize(filePart) + rest]; }
    const folders = this._folders();
    const out: string[] = [];
    for (const f of folders) {
      out.push(path.join(f, filePart) + rest);
      const first = filePart.split(/[\\/]/)[0];
      if (folders.length > 1 && first === path.basename(f)) { out.push(path.join(f, filePart.slice(first.length + 1)) + rest); }
    }
    return out;
  }
}

/** Compresses sorted line numbers into ranges: [1,2,3,7] → "1-3, 7". */
export function lineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) { j++; }
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** Groups sorted line numbers into [from, to] runs. */
export function lineRuns(lines: number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const l of sorted) {
    const last = out[out.length - 1];
    if (last && l === last[1] + 1) { last[1] = l; } else { out.push([l, l]); }
  }
  return out;
}
