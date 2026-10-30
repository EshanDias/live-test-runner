import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverPythonTests, logicalLines, matchesPytestName, matchesPythonFile } from '../src/session/discovery/pythonDiscovery';
import { findCandidates, venvPython } from '../src/python/PythonInterpreters';

const names = (src: string) => {
  const r = discoverPythonTests(src);
  const out: string[] = r.rootTests.map((t) => `${t.fullName}@${t.line}`);
  const walk = (suites: typeof r.suites) => {
    for (const s of suites) {
      for (const t of s.tests) { out.push(`${t.fullName}@${t.line}`); }
      walk(s.children);
    }
  };
  walk(r.suites);
  return out;
};

describe('python static discovery', () => {
  it('finds module-level tests, test classes, nested classes and parametrize templates (def lines)', () => {
    const src = [
      'import pytest',                      // 1
      '',                                   // 2
      'def test_plain():',                  // 3
      '    def test_inner_helper():',       // 4  nested function: not a test
      '        pass',                       // 5
      '',                                   // 6
      '@pytest.mark.parametrize(',          // 7
      '    "a, b",',                        // 8
      '    [(1, 2), (3, 4)],',              // 9
      ')',                                  // 10
      'async def test_param(a, b):',        // 11
      '    assert a',                       // 12
      '',                                   // 13
      'class TestCart:',                    // 14
      '    def test_add(self):',            // 15
      '        pass',                       // 16
      '    def helper(self):',              // 17
      '        pass',                       // 18
      '    class TestNested:',              // 19
      '        @pytest.mark.parametrize("x", [1])', // 20
      '        def test_inner(self, x):',   // 21
      '            pass',                   // 22
      '',                                   // 23
      'def helper():',                      // 24
      '    pass',                           // 25
    ].join('\n');
    expect(names(src)).toEqual([
      'test_plain@3',
      'test_param[…]@11',
      'TestCart test_add@15',
      'TestCart TestNested test_inner[…]@21',
    ]);
  });

  it('skips strings, comments, classes with __init__ and non-test classes; follows unittest.TestCase', () => {
    const src = [
      '"""',
      'def test_in_docstring():',
      '"""',
      '# def test_commented():',
      'class Helper:',
      '    def test_not_collected(self): pass',
      'class TestWithInit:',
      '    def __init__(self): pass',
      '    def test_x(self): pass',
      'import unittest',
      'class Base(unittest.TestCase):',
      '    pass',
      'class CheckThings(Base):',
      '    def test_one(self):',
      '        s = """',
      '    def test_fake(self):',
      '        """',
      '    def test_two(self): pass',
    ].join('\n');
    expect(names(src)).toEqual(['CheckThings test_one@14', 'CheckThings test_two@18']);
  });

  it("follows python_classes / python_functions (prefixes or globs) and pytest's file globs", () => {
    expect(matchesPytestName('test_a', ['test'])).toBe(true);
    expect(matchesPytestName('check_a', ['test', 'check_*'])).toBe(true);
    expect(matchesPytestName('Tests', ['*Suite'])).toBe(false);
    const r = discoverPythonTests('class CartSuite:\n    def check_total(self): pass\n', { classes: ['*Suite'], functions: ['check_'] });
    expect(r.suites[0].tests.map((t) => t.fullName)).toEqual(['CartSuite check_total']);
    expect(matchesPythonFile('test_cart.py')).toBe(true);
    expect(matchesPythonFile('cart_test.py')).toBe(true);
    expect(matchesPythonFile('cart.py')).toBe(false);
    expect(matchesPythonFile('check_cart.py', ['check_*.py'])).toBe(true);
  });

  it('joins bracket continuations and blanks strings in logical lines', () => {
    const lines = logicalLines('x = foo(\n  "a # not a comment",\n  2)  # comment\ny = 1\n');
    expect(lines.map((l) => [l.line, l.text])).toEqual([[0, 'x = foo( "", 2)'], [3, 'y = 1']]);
  });

  it('reads every test of the e2e fixture like pytest collects them (templates for parametrize)', () => {
    const file = path.join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'pytest-basic', 'tests', 'test_cart.py');
    expect(names(fs.readFileSync(file, 'utf8')).map((n) => n.split('@')[0])).toEqual([
      'test_discount[…]', 'test_logs', 'test_skipped', 'test_expected_failure', 'test_setup_error',
      'TestCart test_empty', 'TestCart test_add', 'TestCart test_rejects_bad_qty[…]', 'TestCart test_fails_on_purpose',
      'TestCart TestNested test_inner',
    ]);
  });
});

describe('python interpreter candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr python '));
  const make = (rel: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); return p; };

  it('orders: selected, setting, project venvs, workspace venv, activated env inside the project, then PATH', async () => {
    const venv = make(path.relative(root, venvPython(path.join(root, '.venv'))));
    const other = make(path.relative(root, venvPython(path.join(root, 'venv'))));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr outside '));
    const list = await findCandidates(root, {
      chosen: '/chosen/python',
      setting: 'tools/python',
      env: { VIRTUAL_ENV: outside },
      tool: async () => undefined,
    });
    expect(list.map((c) => c.source)).toEqual([
      'selected', 'liveTestRunner.pythonPath', '.venv', 'venv',
      ...(process.platform === 'win32' ? ['py launcher', 'PATH'] : ['PATH', 'PATH']),
    ]);
    expect(list[1].python).toBe(path.resolve(root, 'tools/python'));
    expect(list[2].python).toBe(venv);
    expect(list[3].python).toBe(other);
  });

  it('asks poetry only when its lock file is there', async () => {
    const asked: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr poetry '));
    await findCandidates(dir, { env: {}, tool: async (cmd) => { asked.push(cmd); return undefined; } });
    expect(asked).toEqual([]);
    fs.writeFileSync(path.join(dir, 'poetry.lock'), '');
    await findCandidates(dir, { env: {}, tool: async (cmd) => { asked.push(cmd); return undefined; } });
    expect(asked).toEqual(['poetry']);
  });
});
