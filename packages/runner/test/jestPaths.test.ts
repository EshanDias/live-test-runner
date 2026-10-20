import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetProjectRoots, fromJestPath, registerProjectRoot, toJestPath } from '../src/resolution/JestPaths';
import { toJestPathArg } from '../src/JestRunner';
import { ResultParser } from '../src/parsing/ResultParser';

// Symlinks need admin rights on Windows, and Windows paths are not translated.
const posix = process.platform === 'win32' ? describe.skip : describe;

posix('JestPaths — project opened through a symlink', () => {
  let tmp: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    _resetProjectRoots();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr paths ')));
    real = path.join(tmp, 'real project');
    link = path.join(tmp, 'linked project');
    fs.mkdirSync(path.join(real, 'src'), { recursive: true });
    fs.symlinkSync(real, link, 'dir');
  });

  afterEach(() => {
    _resetProjectRoots();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes paths through until the root is registered', () => {
    const p = path.join(link, 'src', 'a.test.js');
    expect(toJestPath(p)).toBe(p);
    expect(fromJestPath(path.join(real, 'src', 'a.test.js'))).toBe(path.join(real, 'src', 'a.test.js'));
  });

  it('sends real paths to Jest and reads Jest paths back in the editor spelling', () => {
    registerProjectRoot(link);
    const editor = path.join(link, 'src', 'a.test.js');
    const jest = path.join(real, 'src', 'a.test.js');
    expect(toJestPath(editor)).toBe(jest);
    expect(fromJestPath(jest)).toBe(editor);
    expect(toJestPathArg(editor)).toBe(jest);
    expect(toJestPath(link)).toBe(real);
  });

  it('leaves paths outside the root and look-alike prefixes alone', () => {
    registerProjectRoot(link);
    const sibling = `${real}-other/src/a.js`;
    expect(fromJestPath(sibling)).toBe(sibling);
    expect(fromJestPath('/elsewhere/a.js')).toBe('/elsewhere/a.js');
  });

  it('does nothing for a root that is not a symlink', () => {
    registerProjectRoot(real);
    const p = path.join(real, 'src', 'a.test.js');
    expect(toJestPath(p)).toBe(p);
    expect(fromJestPath(p)).toBe(p);
  });

  it('maps file paths in Jest JSON results', () => {
    registerProjectRoot(link);
    const json = JSON.stringify({
      testResults: [{ name: path.join(real, 'src', 'a.test.js'), status: 'passed', assertionResults: [] }],
    });
    const result = new ResultParser().parse(true, json, '');
    expect(result.fileResults[0].testFilePath).toBe(path.join(link, 'src', 'a.test.js'));
  });
});
