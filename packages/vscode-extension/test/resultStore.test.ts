import { ResultStore, makeNodeId } from '../src/store/ResultStore';

const FILE = 'c:\\p\\a.test.js';

/** File → suite "S" → tests; like static discovery does. */
function discovered(store: ResultStore, tests: string[]): string {
  store.fileDiscovered(FILE, FILE, 'a.test.js');
  const suite = makeNodeId(FILE, [], 'S');
  store.nodeDiscovered(FILE, suite, null, 'suite', 'S', 'S');
  for (const t of tests) {
    store.nodeDiscovered(FILE, makeNodeId(FILE, ['S'], t), suite, 'test', t, `S ${t}`);
  }
  return suite;
}

function result(store: ResultStore, title: string, status: 'passed' | 'failed') {
  const suite = makeNodeId(FILE, [], 'S');
  const id = makeNodeId(FILE, ['S'], title);
  store.nodeStarted(FILE, suite, null, 'suite', 'S', 'S');
  store.nodeStarted(FILE, id, suite, 'test', title, `S ${title}`);
  store.nodeResult(id, status);
  store.bubbleUpStatus(id);
}

const tests = (store: ResultStore) => store.getFileNodes(FILE).filter((n) => n.type === 'test');

describe('ResultStore.cleanupStaleNodes', () => {
  it('keeps finished tests when a placeholder in their suite got no result', () => {
    // Regression: the suite stayed "running" because of the placeholder and was
    // removed together with every finished test in it.
    const store = new ResultStore();
    discovered(store, ['case $case', 'other']);
    store.markFileRunning(FILE);
    result(store, 'case 1', 'passed');
    result(store, 'case 2', 'failed');
    result(store, 'other', 'passed');
    store.cleanupStaleNodes(FILE, true);

    expect(tests(store).map((n) => `${n.name}:${n.status}`).sort()).toEqual(['case 1:passed', 'case 2:failed', 'other:passed']);
    expect(store.getNode(makeNodeId(FILE, [], 'S'))?.status).toBe('failed');
    expect(store.getFile(FILE)?.status).toBe('failed');
    expect(store.getSummary()).toMatchObject({ total: 3, passed: 2, failed: 1, running: 0 });
  });

  it('reverts to pending (keeps the tree) when nothing ran', () => {
    const store = new ResultStore();
    discovered(store, ['a', 'b']);
    store.markFileRunning(FILE);
    store.cleanupStaleNodes(FILE, false);
    expect(tests(store).map((n) => n.status)).toEqual(['pending', 'pending']);
    expect(store.getSummary().running).toBe(0);
  });
});

describe('ResultStore summary and lifecycle', () => {
  it('removeFile lowers the total (BUG-11)', () => {
    const store = new ResultStore();
    discovered(store, ['a', 'b']);
    expect(store.getSummary().total).toBe(2);
    store.removeFile(FILE);
    expect(store.getSummary().total).toBe(0);
  });

  it('clear() drops the line maps (BUG-11)', () => {
    const store = new ResultStore();
    discovered(store, ['a']);
    store.setLineEntry(FILE, 3, { nodeId: 'x', fileId: FILE });
    store.clear();
    expect(store.getLineMap(FILE).size).toBe(0);
  });

  it('resetRunning reverts spinners and keeps finished results (BUG-23)', () => {
    const store = new ResultStore();
    discovered(store, ['a', 'b']);
    store.markFileRunning(FILE);
    store.nodeResult(makeNodeId(FILE, ['S'], 'a'), 'passed');
    store.resetRunning();
    expect(tests(store).map((n) => `${n.name}:${n.status}`)).toEqual(['a:passed', 'b:pending']);
    expect(store.getSummary().running).toBe(0);
  });

  it('markFileExcluded shows a file Jest never runs as skipped (BUG-24)', () => {
    const store = new ResultStore();
    discovered(store, ['a']);
    store.markFileExcluded(FILE, 'excluded');
    expect(store.getFile(FILE)?.status).toBe('skipped');
    expect(tests(store)[0].status).toBe('skipped');
  });

  it('failFile marks every test failed with the reason (hang)', () => {
    const store = new ResultStore();
    discovered(store, ['a', 'b']);
    store.failFile(FILE, 'hung');
    expect(tests(store).every((n) => n.status === 'failed' && n.failureMessages[0] === 'hung')).toBe(true);
    expect(store.getSummary().failed).toBe(2);
  });

  it('findFileKey matches another spelling of the same path (BUG-13)', () => {
    const store = new ResultStore();
    discovered(store, ['a']);
    expect(store.findFileKey('C:/p/a.test.js')).toBe(FILE);
    expect(store.findFileKey('C:\\p\\b.test.js')).toBeUndefined();
  });
});

describe('ResultStore file groups (Vitest projects, D12)', () => {
  it('sets, serialises and clears each file\'s group', () => {
    const store = new ResultStore();
    store.fileDiscovered('/p/a.test.js', '/p/a.test.js', 'a.test.js');
    store.fileDiscovered('/p/b.test.js', '/p/b.test.js', 'b.test.js');
    store.setFileGroups({ '/p/a.test.js': 'unit', '/p/missing.test.js': 'x' });
    expect(store.getFile('/p/a.test.js')?.group).toBe('unit');
    expect(store.getFile('/p/b.test.js')?.group).toBeUndefined();
    expect((store.toJSON() as { files: { group?: string }[] }).files.map((f) => f.group)).toEqual(['unit', undefined]);
    store.setFileGroups(undefined);
    expect(store.getFile('/p/a.test.js')?.group).toBeUndefined();
  });
});
