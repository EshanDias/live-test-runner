/**
 * Static discovery for pytest (pytest plan D12): a line scanner, no Python
 * needed, so the Explorer and the gutter show a project's tests before
 * anything runs. pytest's own collection replaces the guess at Start (the
 * results reconcile the tree), so it only has to be right for ordinary code:
 *
 *  - test functions: module-level `def` / `async def` whose name matches
 *    `python_functions` (default prefix `test`);
 *  - test classes: `class` matching `python_classes` (default `Test`) without
 *    an `__init__`, or a `unittest.TestCase` subclass (also through one level
 *    of local base classes); their matching methods, and nested test classes;
 *  - `@pytest.mark.parametrize` → a template `name[…]` (its cases appear when
 *    pytest runs);
 *  - triple-quoted strings and comments are skipped; lines are 1-based `def` lines.
 */
import { DEFAULT_PYTHON_FILES, pytestSettings } from '@live-test-runner/runner';
import { DiscoveredStructure, DiscoveredSuite, DiscoveredTest, TestFileDiscoverer } from './TestFileDiscoverer';

export interface PythonNamingRules {
  /** `python_classes` (prefixes or globs). */
  classes: string[];
  /** `python_functions` (prefixes or globs). */
  functions: string[];
}

export const DEFAULT_NAMING: PythonNamingRules = { classes: ['Test'], functions: ['test'] };

/** pytest's rule: an entry with a glob character is a glob, otherwise a prefix. */
export function matchesPytestName(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (/[*?[]/.test(p) ? globRe(p).test(name) : name.startsWith(p)));
}

const globCache = new Map<string, RegExp>();
function globRe(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    let src = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') { src += '.*'; } else if (c === '?') { src += '.'; } else if (c === '[') {
        const end = glob.indexOf(']', i + 1);
        if (end < 0) { src += '\\['; } else {
          const body = glob.slice(i + 1, end);
          src += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
          i = end;
        }
      } else { src += c.replace(/[.+^${}()|\\]/g, '\\$&'); }
    }
    re = new RegExp(`^${src}$`);
    globCache.set(glob, re);
  }
  return re;
}

/** A `python_files` entry (a basename glob) matches the file's name. */
export function matchesPythonFile(fileName: string, patterns: string[] = DEFAULT_PYTHON_FILES): boolean {
  return patterns.some((p) => globRe(p).test(fileName));
}

interface ClassFrame {
  indent: number;
  suite: DiscoveredSuite;
  /** Collected by pytest (a test class), or just a container to look inside. */
  isTestClass: boolean;
  /** unittest.TestCase: every `test*` method counts, whatever python_classes says. */
  isUnittest: boolean;
  fullName: string;
  hasInit: boolean;
}

/** One logical line: the code of a statement (continuations joined, strings blanked) and its first line (0-based). */
interface LogicalLine {
  text: string;
  line: number;
}

/**
 * The file as logical lines: string literals blanked (their quotes kept),
 * comments dropped, statements continued inside brackets or with a trailing
 * backslash joined onto their first line. Blank lines are left out.
 */
export function logicalLines(source: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let cur = '';
  let curLine = -1;
  let depth = 0;
  let quote: string | undefined;
  const lines = source.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    let code = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (raw.startsWith(quote, i)) { code += quote; i += quote.length - 1; quote = undefined; }
        continue;
      }
      if (c === '#') { break; }
      if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) { quote = raw.slice(i, i + 3); code += quote; i += 2; continue; }
      if (c === '"' || c === "'") { quote = c; code += c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; } else if ((c === ')' || c === ']' || c === '}') && depth > 0) { depth--; }
      code += c;
    }
    // A one-quote string never spans lines (unless escaped — rare): close it.
    if (quote && quote.length === 1) { code += quote; quote = undefined; }
    if (curLine < 0) {
      if (!code.trim()) { continue; }
      curLine = n;
      cur = code;
    } else {
      cur += ' ' + code.trim();
    }
    const continued = depth > 0 || quote !== undefined || /\\\s*$/.test(code);
    if (!continued) {
      out.push({ text: cur.replace(/\s+$/, ''), line: curLine });
      cur = '';
      curLine = -1;
    }
  }
  if (curLine >= 0) { out.push({ text: cur, line: curLine }); }
  return out;
}

const UNITTEST_BASE_RE = /(^|[\s,(.])(TestCase|IsolatedAsyncioTestCase)\s*[,)]/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)\s*(?:\((.*)\))?\s*:/;
const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PARAMETRIZE_RE = /(^|[\s.@])mark\.parametrize\s*\(/;

/**
 * The tests of one Python file. Never throws: code it does not understand
 * yields what was understood so far.
 */
export function discoverPythonTests(source: string, naming: PythonNamingRules = DEFAULT_NAMING): DiscoveredStructure {
  const rootTests: DiscoveredTest[] = [];
  const suites: DiscoveredSuite[] = [];
  const stack: ClassFrame[] = [];
  /** Local classes that are unittest.TestCase subclasses (for their own subclasses). */
  const unittestClasses = new Set<string>();
  let decorators: string[] = [];
  /** Inside a def body (its indent): nested defs and classes are not collected. */
  let defIndent = -1;

  const finishClass = (frame: ClassFrame) => {
    // pytest skips test classes with an __init__ (it warns "cannot collect").
    const keep = frame.isTestClass && !(frame.hasInit && !frame.isUnittest)
      && (frame.suite.tests.length > 0 || frame.suite.children.length > 0);
    if (!keep) { return; }
    const parent = stack[stack.length - 1];
    if (parent) { parent.suite.children.push(frame.suite); } else { suites.push(frame.suite); }
  };

  for (const { text, line } of logicalLines(source)) {
    const indent = text.length - text.trimStart().length;
    const body = text.trim();
    // A docstring or other bare string statement.
    if (/^[rRbBuUfF]*("|')/.test(body)) { continue; }
    if (defIndent >= 0) {
      if (indent > defIndent) { continue; }
      defIndent = -1;
    }
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      finishClass(stack.pop()!);
    }
    if (body.startsWith('@')) {
      decorators.push(body);
      continue;
    }
    const cls = CLASS_RE.exec(body);
    if (cls) {
      const [, name, bases = ''] = cls;
      const parent = stack[stack.length - 1];
      const unittest = UNITTEST_BASE_RE.test(`(${bases})`) || bases.split(',').some((b) => unittestClasses.has(b.trim()));
      if (unittest) { unittestClasses.add(name); }
      const collectable = !parent || parent.isTestClass;
      stack.push({
        indent,
        isTestClass: collectable && (unittest || matchesPytestName(name, naming.classes)),
        isUnittest: unittest,
        fullName: parent ? `${parent.fullName} ${name}` : name,
        hasInit: false,
        suite: { name, line: line + 1, tests: [], children: [], isSharedVars: false, sharedVarNames: [] },
      });
      decorators = [];
      continue;
    }
    const fn = DEF_RE.exec(body);
    if (fn) {
      const name = fn[1];
      const parent = stack[stack.length - 1];
      const parametrized = decorators.some((d) => PARAMETRIZE_RE.test(d));
      decorators = [];
      defIndent = indent;
      if (parent) {
        if (name === '__init__') { parent.hasInit = true; }
        const isTest = parent.isTestClass && (matchesPytestName(name, naming.functions) || (parent.isUnittest && name.startsWith('test')));
        if (isTest) {
          // unittest methods cannot be parametrized by pytest.
          const title = parametrized && !parent.isUnittest ? `${name}[…]` : name;
          parent.suite.tests.push({ name: title, line: line + 1, fullName: `${parent.fullName} ${title}` });
        }
      } else if (indent === 0 && matchesPytestName(name, naming.functions)) {
        const title = parametrized ? `${name}[…]` : name;
        rootTests.push({ name: title, line: line + 1, fullName: title });
      }
      continue;
    }
    decorators = [];
  }
  while (stack.length > 0) { finishClass(stack.pop()!); }
  return { suites, rootTests };
}

/** Folders never searched for Python tests: dependencies, environments, caches, build output. */
const PYTHON_EXCLUDE = '{**/node_modules/**,**/site-packages/**,**/.venv/**,**/venv/**,**/.tox/**,**/.nox/**,**/__pycache__/**,**/.git/**,**/build/**,**/dist/**,**/*.egg-info/**}';

/** pytest: `python_files` (under `testpaths` when set), read with the line scanner. */
export function pythonDiscoverer(): TestFileDiscoverer {
  const naming = new Map<string, PythonNamingRules>();
  const rules = (root: string): PythonNamingRules => {
    let r = naming.get(root);
    if (!r) {
      const s = pytestSettings(root);
      r = { classes: s.pythonClasses, functions: s.pythonFunctions };
      naming.set(root, r);
    }
    return r;
  };
  return {
    patterns: (root) => {
      naming.delete(root); // the config may have changed: re-read with every discovery pass
      const s = pytestSettings(root);
      const dirs = s.testpaths.length > 0 ? s.testpaths.map((t) => t.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '')) : [''];
      return dirs.flatMap((d) => s.pythonFiles.map((f) => (d ? `${d}/**/${f}` : `**/${f}`)));
    },
    exclude: PYTHON_EXCLUDE,
    // The patterns choose the files; a file pytest lists (custom python_files) is always readable.
    accepts: (fp) => /\.py$/i.test(fp),
    discover: (source, _fp, root) => discoverPythonTests(source, rules(root)),
    testsLabel: 'pytest tests',
  };
}
