'use strict';
/**
 * sourceMapLookup.js — reads a source map (v3) back: generated position →
 * position in the file's own source. Used by the session transforms when the
 * code they instrument was produced by another transform (TypeScript, Vue,
 * Svelte, …): recorded lines and coverage locations are then the editor's.
 *
 * No dependencies (runs inside the test process, with whatever the project
 * has installed).
 */

const path = require('path');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A map as transformers return it: an object, a JSON string, or a SourceMapGenerator-like object. */
function normalizeMap(map) {
  if (!map) { return null; }
  if (typeof map === 'string') {
    try { return JSON.parse(map); } catch (_) { return null; }
  }
  if (typeof map.mappings !== 'string' && typeof map.toJSON === 'function') {
    try { return map.toJSON(); } catch (_) { return null; }
  }
  return typeof map.mappings === 'string' ? map : null;
}

/**
 * Which `sources` entries are `file` itself (by base name — sources are
 * spelt relative, absolute or as URLs). None matches: all count (a map
 * without useful names).
 */
function ownSources(map, file) {
  const sources = Array.isArray(map.sources) ? map.sources : [];
  if (!file) { return null; }
  const base = path.basename(file).toLowerCase();
  const own = new Set();
  sources.forEach((s, i) => {
    const clean = String(s || '').split(/[?#]/)[0].replace(/\\/g, '/');
    if (clean.split('/').pop().toLowerCase() === base) { own.add(i); }
  });
  return own.size > 0 ? own : null;
}

/**
 * @param {object|string} map the source map
 * @param {string} [file] the file the map should lead back to: segments for
 *   other sources (helpers, virtual modules) are ignored
 * @returns {((line0: number, col: number) => { line: number, column: number } | undefined) | null}
 *   the original position (1-based line, 0-based column) at a generated
 *   position (0-based line): the last mapped segment at or before `col` on
 *   that line, else the line's first mapped segment; undefined when the line
 *   has none. null when the map cannot be read.
 */
function sourceMapLookup(map, file) {
  const m = normalizeMap(map);
  if (!m) { return null; }
  const own = ownSources(m, file);
  const lines = [];
  const mappings = m.mappings || '';
  let genCol = 0, src = 0, origLine = 0, origCol = 0;
  let line = [];
  let i = 0;
  const readVlq = () => {
    let result = 0, shift = 0, c;
    do {
      c = B64.indexOf(mappings[i++]);
      if (c < 0) { throw new Error('invalid source map mappings'); }
      result += (c & 31) * 2 ** shift;
      shift += 5;
    } while (c & 32);
    return result % 2 === 1 ? -Math.floor(result / 2) : result / 2;
  };
  const isSep = (ch) => ch === undefined || ch === ',' || ch === ';';
  try {
    while (i <= mappings.length) {
      const ch = mappings[i];
      if (ch === ';' || ch === undefined) {
        lines.push(line);
        line = [];
        genCol = 0;
        i++;
        if (ch === undefined) { break; }
        continue;
      }
      if (ch === ',') { i++; continue; }
      genCol += readVlq();
      if (!isSep(mappings[i])) {
        src += readVlq();
        origLine += readVlq();
        origCol += readVlq();
        if (!isSep(mappings[i])) { readVlq(); } // name
        if (!own || own.has(src)) { line.push([genCol, origLine, origCol]); }
      }
    }
  } catch (_) {
    return null;
  }
  for (const l of lines) { l.sort((a, b) => a[0] - b[0]); }
  return (line0, col) => {
    const segs = lines[line0];
    if (!segs || segs.length === 0) { return undefined; }
    let best;
    for (const seg of segs) { if (seg[0] <= col) { best = seg; } else { break; } }
    if (!best) { return { line: segs[0][1] + 1, column: segs[0][2] }; }
    return { line: best[1] + 1, column: best[2] + (col - best[0]) };
  };
}

/** The map has a source that is `file` itself (by base name) — code compiled from that file. */
function mapsBackTo(map, file) {
  const m = normalizeMap(map);
  return !!m && ownSources(m, String(file).split(/[?#]/)[0]) !== null;
}

module.exports = { sourceMapLookup, normalizeMap, mapsBackTo };
