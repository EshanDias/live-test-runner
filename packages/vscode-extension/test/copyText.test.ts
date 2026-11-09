import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { failuresAsText, failuresForAI } from '../src/views/copyText';

let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-copy-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'parse.js'), 'function parse(s) {\n  return s.value.trim();\n}\nmodule.exports = { parse };\n');
  fs.writeFileSync(path.join(root, 'src', 'a.test.js'), "const { parse } = require('./parse');\ntest('adds', () => {\n  expect(1 + 1).toBe(3);\n});\n\ntest('parses', () => {\n  parse({});\n});\n");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } };
const testFile = () => path.join(root, 'src', 'a.test.js');

describe('copy texts', () => {
  it('Copy all: name and message per failure', () => {
    expect(failuresAsText([
      { fullName: 'adds', testFile: testFile(), failureMessages: ['Error: one\n'] },
      { fullName: 'parses', testFile: testFile(), failureMessages: ['TypeError: two'] },
    ])).toBe('✗ adds\n\nError: one\n\n✗ parses\n\nTypeError: two');
  });

  it('Copy for AI: framework, location, error, the test source and where it was thrown', () => {
    const text = failuresForAI([{
      fullName: 'parses', testFile: testFile(), line: 6, failureMessages: [
        `TypeError: Cannot read properties of undefined (reading 'trim')\n    at parse (${path.join(root, 'src', 'parse.js')}:2:18)\n    at Object.<anonymous> (${testFile()}:7:3)`,
      ],
    }], 'Jest', root, read);
    expect(text).toContain('A Jest test fails.');
    expect(text).toContain('File: src/a.test.js:6');
    expect(text).toContain("TypeError: Cannot read properties of undefined (reading 'trim')\n\nat src/parse.js:2:18\nat src/a.test.js:7:3");
    expect(text).not.toContain(root); // no machine paths
    expect(text).toContain("Test source (src/a.test.js, lines 6–8):\n\n```js\ntest('parses', () => {\n  parse({});\n});\n```");
    expect(text).toMatch(/Thrown from src\/parse\.js:2:[\s\S]*>    2 \|   return s\.value\.trim\(\);/);
  });

  it('a test ends where the next one starts; relative frames (Vitest) resolve from the root', () => {
    const text = failuresForAI([{
      fullName: 'adds', testFile: testFile(), line: 2, nextLine: 6,
      failureMessages: ['AssertionError: expected 2 to be 3\n\n❯ src/a.test.js:3:17'],
    }], 'Vitest', root, read);
    expect(text).toContain('lines 2–4');
    expect(text).not.toContain('Thrown from'); // thrown in the test itself
  });

  it('a fence the message cannot close', () => {
    const text = failuresForAI([{ fullName: 't', testFile: testFile(), failureMessages: ['Error: ```oops```'] }], 'Jest', root, read);
    expect(text).toContain('````text\nError: ```oops```\n````');
  });
});

describe('failingTestNames', () => {
  it('lists failed tests as file › full name', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ResultStore, makeNodeId } = require('../src/store/ResultStore');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { failingTestNames } = require('../src/views/copyText');
    const store = new ResultStore();
    const file = path.join(root, 'src', 'a.test.js');
    store.fileDiscovered(file, file, 'a.test.js');
    for (const [name, status] of [['adds', 'failed'], ['parses', 'passed']]) {
      const id = makeNodeId(file, [], name);
      store.nodeDiscovered(file, id, null, 'test', name, name);
      store.nodeResult(id, status);
    }
    expect(failingTestNames(store, root)).toBe('src/a.test.js › adds');
  });
});
