import * as fs from 'fs';
import * as path from 'path';
import { runInNewContext } from 'vm';
import { durationLabel } from '../src/utils/duration';

interface WebviewContext {
  window: {
    LiveTestUtils?: {
      durationLabel: (ms: number | null) => string;
    };
  };
}

const webviewContext: WebviewContext = { window: {} };
const webviewUtils = fs.readFileSync(path.resolve(__dirname, '../src/webview/utils.js'), 'utf8');
runInNewContext(webviewUtils, webviewContext);

describe('durationLabel', () => {
  it.each([
    [123.6, '124ms'],
    [999.6, '1s'],
    [1234.6, '1s'],
    [61002, '1m 1s'],
    [3_600_000, '1h'],
  ])('formats %s ms as %s', (ms, expected) => {
    expect(durationLabel(ms)).toBe(expected);
    expect(webviewContext.window.LiveTestUtils?.durationLabel(ms)).toBe(expected);
  });
});
