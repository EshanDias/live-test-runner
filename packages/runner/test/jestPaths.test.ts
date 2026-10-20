import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetProjectRoots, fromJestPath, registerProjectRoot, toJestPath } from '../src/resolution/JestPaths';
import { toJestPathArg } from '../src/JestRunner';
import { ResultParser } from '../src/parsing/ResultParser';

// Creating symlinks needs admin rights on Windows.
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

describe('JestPaths — Windows 8.3 short names (simulated)', () => {
  // GitHub's Windows runners: %TEMP% is C:\Users\RUNNER~1\…, Jest's realpath is C:\Users\runneradmin\….
  const short = 'c:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ltr e2e\\basic project';
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ltr e2e\\basic project';

  beforeEach(() => {
    _resetProjectRoots(true);
    registerProjectRoot(short, () => long);
  });
  afterAll(() => _resetProjectRoots());

  it('sends the long path to Jest, whatever the slashes or case', () => {
    expect(toJestPath(`${short}\\src\\math.test.js`)).toBe(`${long}\\src\\math.test.js`);
    expect(toJestPath('C:/Users/runner~1/AppData/Local/Temp/ltr e2e/basic project/src/a.js'))
      .toBe(`${long}/src/a.js`);
    expect(toJestPathArg(`${short}\\src\\math.test.js`))
      .toBe('C:/Users/runneradmin/AppData/Local/Temp/ltr e2e/basic project/src/math.test.js');
  });

  it("maps Jest's long paths back to the editor's short spelling", () => {
    expect(fromJestPath(`${long}\\src\\math.test.js`)).toBe(`${short}\\src\\math.test.js`);
    expect(fromJestPath('c:\\users\\RUNNERADMIN\\AppData\\Local\\Temp\\ltr e2e\\basic project\\x.js'))
      .toBe(`${short}\\x.js`);
  });

  it('leaves other paths and look-alike prefixes alone', () => {
    expect(fromJestPath(`${long} 2\\a.js`)).toBe(`${long} 2\\a.js`);
    expect(toJestPath('D:\\other\\a.js')).toBe('D:\\other\\a.js');
  });

  it('does not map a root that differs only in drive-letter case', () => {
    _resetProjectRoots(true);
    registerProjectRoot('c:\\proj', () => 'C:\\proj');
    expect(toJestPath('c:\\proj\\a.js')).toBe('c:\\proj\\a.js');
  });

  it('maps file paths in Jest JSON results', () => {
    const json = JSON.stringify({ testResults: [{ name: `${long}\\src\\a.test.js`, status: 'passed', assertionResults: [] }] });
    expect(new ResultParser().parse(true, json, '').fileResults[0].testFilePath).toBe(`${short}\\src\\a.test.js`);
  });
});
