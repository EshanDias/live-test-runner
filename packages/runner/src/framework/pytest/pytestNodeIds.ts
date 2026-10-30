/**
 * Test names ⇄ pytest node ids (pytest plan D10).
 *
 * The extension names a pytest test like a Jest one: its classes and its own
 * name, space-joined (`TestCart test_total[2-items]`); a test outside any
 * class is just its name; `(root)` is the file's top level. pytest selects
 * tests by node id — `<file>::TestCart::test_total[2-items]` — never by `-k`,
 * which matches substrings and markers and would run the wrong scope.
 *
 * Class and function names cannot hold spaces or `[`, so everything from the
 * first `[` on is the parametrize id (which may hold anything). A template
 * (`test_total[…]`, discovered from `@pytest.mark.parametrize`) selects the
 * function: every case.
 */
import * as fs from 'fs';
import * as path from 'path';

const PART_RE = /^[A-Za-z_][\w.]*$/;

/** True for a name the static discovery made for a parametrized function (all its cases). */
export function isTemplateName(name: string): boolean {
  return /\[(?:…|<dynamic>)\]$/.test(name);
}

/**
 * The node id of a test or suite in `file`, or undefined when the name cannot
 * be a pytest name (the caller then runs the whole file).
 */
export function nodeIdFor(file: string, fullName: string, isSuite = false): string | undefined {
  if (fullName === '(root)' || fullName === '') { return file; }
  const bracket = fullName.indexOf('[');
  const head = bracket < 0 ? fullName : fullName.slice(0, bracket);
  let param = bracket < 0 ? '' : fullName.slice(bracket);
  const parts = head.split(' ').filter(Boolean);
  if (parts[0] === '(root)') { parts.shift(); }
  if (parts.length === 0 || !parts.every((p) => PART_RE.test(p))) { return undefined; }
  if (param && (isTemplateName(fullName) || (isSuite && /…|<dynamic>/.test(param)))) { param = ''; }
  return [file, ...parts].join('::') + param;
}

/** Node ids for `names` in `file`; undefined when one of them cannot be expressed (run the file). */
export function nodeIdsFor(file: string, names: string[], isSuite = false): string[] | undefined {
  const ids: string[] = [];
  for (const n of names) {
    const id = nodeIdFor(file, n, isSuite);
    if (!id) { return undefined; }
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** The folder holding `ltr_pytest.py` (written there once per session folder), for PYTHONPATH. */
const written = new Set<string>();
export function pytestPluginDir(sessionDir: string, source: string): string {
  const dir = path.join(sessionDir, 'pytest-plugin');
  const file = path.join(dir, 'ltr_pytest.py');
  if (!written.has(file) || !fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, source, 'utf8');
    written.add(file);
  }
  return dir;
}
