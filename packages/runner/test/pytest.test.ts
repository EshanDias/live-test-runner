import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nodeIdFor, nodeIdsFor, isTemplateName } from '../src/framework/pytest/pytestNodeIds';
import {
  addopts,
  findPytestConfig,
  isPytestProject,
  listOption,
  parseIni,
  parseTomlTables,
  pytestSettings,
  splitArgs,
} from '../src/framework/pytest/pytestConfig';
import { describePython, setPythonFor, unsupportedReason, PythonInfo } from '../src/framework/pytest/python';
import { PytestRunner, toPytestPathArg, pytestExitReason } from '../src/PytestRunner';
import { PytestAdapter } from '../src/framework/adapters/PytestAdapter';
import { RunRequest } from '../src/CommandRunner';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr pytest '));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const info = (over: Partial<PythonInfo> = {}): PythonInfo => ({
  python: '/proj/.venv/bin/python', version: '3.12.4', executable: '/proj/.venv/bin/python', venv: true,
  pytest: '9.1.1', coverage: '7.17.0', ...over,
});

describe('pytest node ids', () => {
  it('turns store names into node ids: classes, nested classes, parameters (anything inside [])', () => {
    expect(nodeIdFor('tests/test_cart.py', 'test_total')).toBe('tests/test_cart.py::test_total');
    expect(nodeIdFor('tests/test_cart.py', 'TestCart test_add')).toBe('tests/test_cart.py::TestCart::test_add');
    expect(nodeIdFor('t.py', 'TestA TestB test_x')).toBe('t.py::TestA::TestB::test_x');
    expect(nodeIdFor('t.py', 'TestK test_p[x y]')).toBe('t.py::TestK::test_p[x y]');
    expect(nodeIdFor('t.py', 'test_p[a [b] c]')).toBe('t.py::test_p[a [b] c]');
    expect(nodeIdFor('t.py', 'test_p[\\xfc[1]]')).toBe('t.py::test_p[\\xfc[1]]');
  });

  it('a template (all cases of a parametrized function) selects the function; a suite selects its class', () => {
    expect(isTemplateName('test_p[…]')).toBe(true);
    expect(nodeIdFor('t.py', 'TestK test_p[…]', true)).toBe('t.py::TestK::test_p');
    expect(nodeIdFor('t.py', 'test_discount[…]')).toBe('t.py::test_discount');
    expect(nodeIdFor('t.py', 'TestCart', true)).toBe('t.py::TestCart');
    expect(nodeIdFor('t.py', '(root)', true)).toBe('t.py');
  });

  it('refuses names that cannot be pytest names (the caller runs the whole file)', () => {
    expect(nodeIdFor('t.py', 'adds 2 + 2')).toBeUndefined();
    expect(nodeIdFor('t.py', 'Math › adds')).toBeUndefined();
    expect(nodeIdsFor('t.py', ['test_a', 'not-a-name'])).toBeUndefined();
    expect(nodeIdsFor('t.py', ['test_a', 'test_a', 'TestB test_c'])).toEqual(['t.py::test_a', 't.py::TestB::test_c']);
  });
});

describe('pytest config', () => {
  it('reads INI sections with continuation lines and comments', () => {
    const s = parseIni('[pytest]\n; comment\naddopts = -ra\n    --strict-markers\ntestpaths =\n  tests\n  integration\n[other]\nx = 1\n');
    expect(s.get('pytest')).toEqual({ addopts: '-ra\n--strict-markers', testpaths: 'tests\nintegration' });
    expect(listOption(s.get('pytest'), 'testpaths')).toEqual(['tests', 'integration']);
    expect(addopts(s.get('pytest'))).toEqual(['-ra', '--strict-markers']);
  });

  it('reads TOML tables with strings and multi-line arrays (comments and quotes inside)', () => {
    const t = parseTomlTables([
      '[project]', 'name = "x" # the name',
      '[tool.pytest.ini_options]',
      'addopts = "--cov=erdantic --cov-report=term"',
      'testpaths = [',
      '  "tests", # main',
      "  'integration',",
      ']',
      'filterwarnings = ["error", "ignore:a # b:DeprecationWarning"]',
      'minversion = "6.0"',
      '[tool."coverage".run]', 'source = ["src"]',
    ].join('\n'));
    expect(t.get('tool.pytest.ini_options')).toEqual({
      addopts: '--cov=erdantic --cov-report=term',
      testpaths: ['tests', 'integration'],
      filterwarnings: ['error', 'ignore:a # b:DeprecationWarning'],
      minversion: '6.0',
    });
    expect(t.get('tool.coverage.run')).toEqual({ source: ['src'] });
  });

  it("finds the config file in pytest's own order", () => {
    const both = tree({ 'pytest.ini': '[pytest]\ntestpaths = a\n', 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["b"]\n' });
    expect(path.basename(findPytestConfig(both)!.file)).toBe('pytest.ini');
    const pyproject = tree({ 'pyproject.toml': '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n', 'setup.cfg': '[tool:pytest]\n' });
    expect(pytestSettings(pyproject).pythonFiles).toEqual(['check_*.py']);
    // pyproject.toml without a pytest table does not count; setup.cfg [tool:pytest] then does.
    const cfg = tree({ 'pyproject.toml': '[project]\nname = "a"\n', 'setup.cfg': '[tool:pytest]\ntestpaths = t\n' });
    expect(path.basename(findPytestConfig(cfg)!.file)).toBe('setup.cfg');
    expect(pytestSettings(tree({})).pythonFiles).toEqual(['test_*.py', '*_test.py']);
  });

  it('detects pytest projects: config, root conftest, or pytest in the dependencies next to tests', () => {
    expect(isPytestProject(tree({ 'pytest.ini': '' }))).toBe(true);
    expect(isPytestProject(tree({ 'conftest.py': '' }))).toBe(true);
    expect(isPytestProject(tree({ 'requirements-dev.txt': 'pytest>=8\n', 'tests/test_a.py': '' }))).toBe(true);
    expect(isPytestProject(tree({ 'pyproject.toml': '[project]\ndependencies = ["pytest"]\n', 'pkg/tests/test_a.py': '' }))).toBe(false);
    expect(isPytestProject(tree({ 'requirements.txt': 'flask\n', 'tests/test_a.py': '' }))).toBe(false);
    expect(isPytestProject(tree({ 'package.json': '{}', 'src/a.test.js': '' }))).toBe(false);
  });

  it('splits addopts like a shell', () => {
    expect(splitArgs(`-m "not slow" --tb=short -k 'a and b' x\\ y`)).toEqual(['-m', 'not slow', '--tb=short', '-k', 'a and b', 'x y']);
  });
});

describe('pytest interpreter', () => {
  it('explains an interpreter that cannot run the tests', () => {
    expect(unsupportedReason(info())).toBeUndefined();
    expect(unsupportedReason(info({ version: '3.11.9' }))).toMatch(/Python 3\.11\.9 is older than the supported 3\.12/);
    expect(unsupportedReason(info({ pytest: undefined }))).toMatch(/pytest is not installed/);
    expect(unsupportedReason(info({ pytest: '6.2.5' }))).toMatch(/pytest 6\.2\.5 is older than the supported 7/);
    expect(unsupportedReason(info({ pytest: '7.0.0' }))).toBeUndefined();
    expect(describePython(info({ xdist: '3.8.0' }))).toBe('Python 3.12.4 · pytest 9.1.1 · coverage 7.17.0 · xdist 3.8.0');
  });
});

describe('PytestRunner command lines', () => {
  const root = path.resolve('/proj');
  const args = async (request: RunRequest, over: Partial<PythonInfo> = {}, extra: string[] = []) => {
    setPythonFor(root, info(over));
    const r = new PytestRunner('', () => {}, '/session', extra);
    r.setProjectRoot(root);
    return (r as unknown as { commandArgs(req: RunRequest): Promise<string[]> }).commandArgs(request);
  };

  it('runs python -m pytest with the plugin, the cache in the session folder, test files relative to the root', async () => {
    expect(await args({ kind: 'files', files: [path.join(root, 'tests', 'test_a.py')] })).toEqual([
      '-m', 'pytest', '-p', 'ltr_pytest', path.join('tests', 'test_a.py'),
      '--color=no', '--continue-on-collection-errors', '-o', `cache_dir=${path.join('/session', 'pytest-cache')}`,
    ]);
  });

  it('selects tests by node id, never -k', async () => {
    const a = await args({ kind: 'testCase', file: path.join(root, 't.py'), testFullName: '', names: ['TestK test_p[x y]', 'test_b'], isTestSuite: false });
    expect(a.slice(4, 6)).toEqual(['t.py::TestK::test_p[x y]', 't.py::test_b']);
    expect(a).not.toContain('-k');
  });

  it('keeps xdist to one process and pytest-cov idle; adds the pytestArgs setting', async () => {
    const a = await args({ kind: 'full', withCoverage: false }, { xdist: '3.8.0', pytestCov: '7.1.0' }, ['-m', 'not slow']);
    expect(a).toEqual(expect.arrayContaining(['-n', '0', '--no-cov', '-m', 'not slow']));
    expect(a.indexOf('-n')).toBeLessThan(a.indexOf('-m', 2));
  });

  it('lists with --collect-only', async () => {
    expect(await args({ kind: 'list' })).toEqual(expect.arrayContaining(['--collect-only', '-q']));
  });

  it('spells paths outside the root absolutely', () => {
    expect(toPytestPathArg(root, path.join(root, 'a', 'test_x.py'))).toBe(path.join('a', 'test_x.py'));
    expect(toPytestPathArg(root, path.resolve('/elsewhere/test_x.py'))).toBe(path.resolve('/elsewhere/test_x.py'));
  });

  it('explains abnormal exit statuses', () => {
    expect(pytestExitReason(0)).toBeUndefined();
    expect(pytestExitReason(5)).toBeUndefined();
    expect(pytestExitReason(4)).toMatch(/addopts/);
  });
});

describe('PytestAdapter', () => {
  it('reads the plugin result and maps a missing one to an explained error', () => {
    const a = new PytestAdapter();
    const r = a.parseResult(false, JSON.stringify({ passed: false, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, errors: [], fileResults: [{ testFilePath: '/p/t.py', status: 'failed', testCases: [], consoleOutput: [] }], exitStatus: 1 }), '');
    expect(r.numFailedTests).toBe(1);
    expect(r.fileResults[0].testFilePath).toBe('/p/t.py');
    const none = a.parseResult(false, 'ERROR: usage: pytest [options]', 'pytest: error: unrecognized arguments: --cov');
    expect(none.passed).toBe(false);
    expect(none.errors[0]).toMatch(/unrecognized arguments: --cov/);
  });

  it('is the python family and asks for the interpreter the extension registered', () => {
    const a = new PytestAdapter();
    expect(a.family).toBe('python');
    expect(a.outputFileArg('/s/r.json')).toEqual(['--ltr-result=/s/r.json']);
    setPythonFor('/no-python', undefined);
    expect(() => a.resolveBinary('/no-python')).toThrow(/Select Python Interpreter/);
    setPythonFor('/with', info({ python: '/with/.venv/bin/python' }));
    expect(a.resolveBinary('/with')).toBe('/with/.venv/bin/python');
  });
});
