import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PythonImportGraph, importedNames, pythonImportRoots } from '../src/session/pythonImports';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr imports '));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe('python import graph', () => {
  it('reads import forms (aliases, lists, parentheses, relative levels), not strings or comments', () => {
    const r = importedNames([
      'import os, a.b as ab',
      'from pkg.mod import (x,',
      '    y as z)',
      'from . import sib',
      'from ..up import thing',
      's = "import fake"',
      '# from nope import x',
    ].join('\n'));
    expect(r.absolute).toEqual(['os', 'a.b', 'pkg.mod', 'pkg.mod.x', 'pkg.mod.y']);
    expect(r.relative).toEqual([{ level: 1, name: '', members: ['sib'] }, { level: 2, name: 'up', members: ['thing'] }]);
  });

  it('finds the test files that use a module directly or through others (src layout, packages)', () => {
    const root = tree({
      'src/shop/__init__.py': '',
      'src/shop/cart.py': 'from shop.money import to_cents\n',
      'src/shop/money.py': '',
      'src/shop/unused.py': '',
      'tests/test_cart.py': 'from shop.cart import Cart\n',
      'tests/test_money.py': 'import shop.money\n',
      'tests/test_other.py': 'import json\n',
      'tests/helpers/__init__.py': '',
      'tests/helpers/fake.py': 'from ..conftest_like import x\n',
    });
    const graph = new PythonImportGraph(pythonImportRoots(root));
    const tests = ['tests/test_cart.py', 'tests/test_money.py', 'tests/test_other.py'].map((t) => path.join(root, t));
    const rel = (fs_: string[]) => fs_.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
    expect(rel(graph.dependents(path.join(root, 'src/shop/money.py'), tests))).toEqual(['tests/test_cart.py', 'tests/test_money.py']);
    expect(rel(graph.dependents(path.join(root, 'src/shop/cart.py'), tests))).toEqual(['tests/test_cart.py']);
    // Importing shop.cart runs shop/__init__.py too.
    expect(rel(graph.dependents(path.join(root, 'src/shop/__init__.py'), tests))).toEqual(['tests/test_cart.py', 'tests/test_money.py']);
    expect(graph.dependents(path.join(root, 'src/shop/unused.py'), tests)).toEqual([]);
  });

  it("resolves a test's sibling modules (pytest puts the test's folder on sys.path) and relative imports", () => {
    const root = tree({
      'tests/test_a.py': 'import helper\nfrom .pkg import mod\n',
      'tests/helper.py': '',
      'tests/pkg/__init__.py': '',
      'tests/pkg/mod.py': '',
    });
    const graph = new PythonImportGraph(pythonImportRoots(root));
    const test = path.join(root, 'tests', 'test_a.py');
    expect(graph.dependents(path.join(root, 'tests', 'helper.py'), [test])).toEqual([test]);
    expect(graph.dependents(path.join(root, 'tests', 'pkg', 'mod.py'), [test])).toEqual([test]);
  });

  it('a conftest.py is used by every test file under its folder', () => {
    const root = tree({ 'tests/conftest.py': '', 'tests/a/test_x.py': '', 'other/test_y.py': '' });
    const graph = new PythonImportGraph([root]);
    const tests = [path.join(root, 'tests', 'a', 'test_x.py'), path.join(root, 'other', 'test_y.py')];
    expect(graph.dependents(path.join(root, 'tests', 'conftest.py'), tests)).toEqual([tests[0]]);
  });

  it('re-reads a file that changed (cached by mtime and size)', () => {
    const root = tree({ 'test_a.py': 'import json\n', 'mod.py': '' });
    const graph = new PythonImportGraph([root]);
    const test = path.join(root, 'test_a.py');
    expect(graph.dependents(path.join(root, 'mod.py'), [test])).toEqual([]);
    fs.writeFileSync(test, 'import json\nimport mod\n');
    expect(graph.dependents(path.join(root, 'mod.py'), [test])).toEqual([test]);
  });
});
