import { BATCH_MS, ExternalChanges, SAVE_ECHO_MS } from '../src/session/ExternalChanges';

function setup(dirty: string[] = []) {
  let now = 1_000_000;
  let timer: { fn: () => void; at: number } | undefined;
  const batches: string[][] = [];
  const ext = new ExternalChanges({
    onChanged: (files) => batches.push(files),
    isDirtyInEditor: (f) => dirty.includes(f),
    now: () => now,
    setTimer: (fn, ms) => { timer = { fn, at: now + ms }; return timer; },
    clearTimer: () => { timer = undefined; },
  });
  const advance = (ms: number) => {
    now += ms;
    if (timer && now >= timer.at) { const t = timer; timer = undefined; t.fn(); }
  };
  return { ext, batches, advance };
}

describe('ExternalChanges (files changed outside the editor)', () => {
  it('batches changes that arrive close together', () => {
    const { ext, batches, advance } = setup();
    ext.fileChanged('/p/src/a.ts');
    advance(100);
    ext.fileChanged('/p/src/b.ts');
    advance(BATCH_MS - 1);
    expect(batches).toEqual([]);
    advance(1);
    expect(batches).toEqual([['/p/src/a.ts', '/p/src/b.ts']]);
  });

  it("ignores the file-system event of the editor's own save", () => {
    const { ext, batches, advance } = setup();
    ext.noteSave('/p/src/a.ts');
    ext.fileChanged('/p/src/a.ts');
    advance(BATCH_MS);
    expect(batches).toEqual([]);
    // …but a later change of the same file on disk counts
    advance(SAVE_ECHO_MS);
    ext.fileChanged('/p/src/a.ts');
    advance(BATCH_MS);
    expect(batches).toEqual([['/p/src/a.ts']]);
  });

  it('ignores node_modules, .git and files with unsaved edits in the editor', () => {
    const { ext, batches, advance } = setup(['/p/src/dirty.ts']);
    ext.fileChanged('/p/node_modules/x/index.js');
    ext.fileChanged('/p/.git/index');
    ext.fileChanged('/p/src/dirty.ts');
    advance(BATCH_MS);
    expect(batches).toEqual([]);
  });

  it('a file changed twice in one batch is listed once', () => {
    const { ext, batches, advance } = setup();
    ext.fileChanged('/p/src/a.ts');
    ext.fileChanged('/p/src/a.ts');
    advance(BATCH_MS);
    expect(batches).toEqual([['/p/src/a.ts']]);
  });
});
