import * as fs from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';

type FileRow = { status?: string; nodes?: { type: string; status: string }[] };

const context: { window: { fileMatchesStatus?: (file: FileRow, filter: string) => boolean } } = { window: {} };
runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/webview/testListLayout.js'), 'utf8'), context);
const matches = (file: FileRow, filter: string) => context.window.fileMatchesStatus!(file, filter);

describe('Explorer status filter (testListLayout.js)', () => {
  it('"running" matches a running file and a file with a running test', () => {
    expect(matches({ status: 'running', nodes: [] }, 'running')).toBe(true);
    expect(matches({ status: 'passed', nodes: [{ type: 'test', status: 'running' }] }, 'running')).toBe(true);
    expect(matches({ status: 'passed', nodes: [{ type: 'suite', status: 'running' }, { type: 'test', status: 'passed' }] }, 'running')).toBe(false);
    expect(matches({ status: 'failed' }, 'running')).toBe(false);
  });

  it('keeps the other filters as before', () => {
    expect(matches({ status: 'passed' }, 'all')).toBe(true);
    expect(matches({ status: 'passed' }, 'passed')).toBe(true);
    expect(matches({ status: 'failed' }, 'passed')).toBe(false);
    expect(matches({}, 'pending')).toBe(true);
    expect(matches({ status: 'pending' }, 'pending')).toBe(true);
    expect(matches({ status: 'running' }, 'pending')).toBe(false);
  });
});
