/** shared/sourceMapLookup.js: generated → original positions, for code compiled from another file (TS, Vue, Svelte…). */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sourceMapLookup } = require('../src/session/instrumentation/shared/sourceMapLookup.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _vlq: vlq } = require('../src/session/instrumentation/vitest/vitestTraceTransform.js');

/** mappings from [genLine][] = [genCol, src, origLine, origCol] (all 0-based, absolute). */
function encode(lines: number[][][]): string {
  let src = 0, ol = 0, oc = 0;
  return lines.map((segs) => {
    let gc = 0;
    return segs.map(([g, s, l, c]) => {
      const out = vlq(g - gc) + vlq(s - src) + vlq(l - ol) + vlq(c - oc);
      gc = g; src = s; ol = l; oc = c;
      return out;
    }).join(',');
  }).join(';');
}

it('maps positions back, with the column offset inside a segment', () => {
  const map = { version: 3, sources: ['/p/src/App.vue'], mappings: encode([[[0, 0, 9, 2]], [], [[4, 0, 12, 0], [10, 0, 13, 4]]]) };
  const look = sourceMapLookup(map, '/p/src/App.vue');
  expect(look(0, 0)).toEqual({ line: 10, column: 2 });
  expect(look(0, 3)).toEqual({ line: 10, column: 5 });
  expect(look(1, 0)).toBeUndefined();
  expect(look(2, 11)).toEqual({ line: 14, column: 5 });
  expect(look(2, 0)).toEqual({ line: 13, column: 0 }); // before the first segment: the line's first one
});

it('ignores segments of other sources (helpers, virtual modules)', () => {
  const map = { version: 3, sources: ['helper.js', '../src/App.vue?vue&type=script'], mappings: encode([[[0, 0, 50, 0]], [[0, 1, 3, 0]]]) };
  const look = sourceMapLookup(map, '/p/src/App.vue');
  expect(look(0, 0)).toBeUndefined();
  expect(look(1, 0)).toEqual({ line: 4, column: 0 });
});

it('accepts JSON strings and SourceMapGenerator-like objects; null for unreadable maps', () => {
  const raw = { version: 3, sources: ['a.svelte'], mappings: encode([[[0, 0, 1, 0]]]) };
  expect(sourceMapLookup(JSON.stringify(raw), '/x/a.svelte')(0, 0)).toEqual({ line: 2, column: 0 });
  expect(sourceMapLookup({ toJSON: () => raw }, '/x/a.svelte')(0, 0)).toEqual({ line: 2, column: 0 });
  expect(sourceMapLookup({ version: 3, sources: [], mappings: '!!' }, '/x/a.svelte')).toBeNull();
  expect(sourceMapLookup(undefined, '/x/a.svelte')).toBeNull();
});
