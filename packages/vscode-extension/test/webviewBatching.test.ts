import { BaseWebviewProvider } from '../src/views/BaseWebviewProvider';
import { ResultStore } from '../src/store/ResultStore';
import { SelectionState } from '../src/store/SelectionState';

/** A panel that records what it would post to its webview. */
class Panel extends BaseWebviewProvider {
  readonly posted: Array<{ type: string; fileIds?: string[]; files?: Array<{ fileId: string }> }> = [];
  constructor(store: ResultStore) {
    super({} as never, store, new SelectionState());
    (this as unknown as { view: unknown }).view = { visible: true, webview: { postMessage: (m: never) => { this.posted.push(m); } } };
  }
  protected _sendInit(): void {}
  protected get _htmlFile(): string { return 'test.html'; }
  types(): string[] { return this.posted.map((m) => m.type); }
}

const files = ['/p/a.test.js', '/p/b.test.js', '/p/c.test.js'];

function panel(): Panel {
  const store = new ResultStore();
  for (const f of files) { store.fileDiscovered(f, f, f.split('/').pop()!); }
  return new Panel(store);
}

describe('webview updates during a run', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends the files that started together, one message per 50 ms (each message redrew the list)', () => {
    const p = panel();
    for (const f of files) { p.onFilesRerunning([f]); }
    expect(p.posted).toHaveLength(0);
    jest.advanceTimersByTime(50);
    expect(p.types()).toEqual(['files-rerunning']);
    expect(p.posted[0].fileIds).toEqual(files);
  });

  it('a file that started and finished in the same window: running first, then its result', () => {
    const p = panel();
    p.onFilesRerunning([files[0]]);
    p.onFileResult(files[0]);
    jest.advanceTimersByTime(50);
    expect(p.types()).toEqual(['files-rerunning', 'batch-file-results']);
  });

  it('a single test rerun is sent at once, after whatever was waiting', () => {
    const p = panel();
    p.onFileResult(files[1]);
    p.onFilesRerunning([files[0]], `${files[0]}::one`);
    expect(p.types()).toEqual(['batch-file-results', 'files-rerunning']);
  });

  it('Stop drops files that only started (nothing shows as running after it); results already in are sent', () => {
    const p = panel();
    p.onFilesRerunning([files[0]]);
    p.onFileResult(files[1]);
    p.onSessionStopped();
    jest.advanceTimersByTime(100);
    expect(p.types()).toEqual(['batch-file-results', 'session-stopped']);
  });
});
