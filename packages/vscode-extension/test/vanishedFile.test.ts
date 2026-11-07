import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vanishedFile } from '../src/session/JestBatchRunner';

describe('vanishedFile (BUG-44)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vanished-'));
  const kept = path.join(dir, 'package.json');
  fs.writeFileSync(kept, '{}');
  const gone = path.join(dir, 'timeouts', 'package.json');

  it('names a file Jest could not open that is gone again', () => {
    expect(vanishedFile(`jest-haste-map: Error: ENOENT: no such file or directory, open '${gone}'`)).toBe(gone);
  });

  it('a file that exists (a real config problem) is not a reason to retry', () => {
    expect(vanishedFile(`Error: ENOENT: no such file or directory, open '${kept}'`)).toBeUndefined();
  });

  it('any other failure is not either', () => {
    expect(vanishedFile('SyntaxError: Unexpected token')).toBeUndefined();
  });
});
