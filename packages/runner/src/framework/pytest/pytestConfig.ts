/**
 * The project's pytest configuration, read the way pytest finds it — only
 * what the extension needs before pytest itself runs: whether the folder is
 * a pytest project, which files hold tests (`python_files`, `testpaths`) and
 * the `addopts` flags that change our runs (`-s`, `-n`, `--cov`).
 *
 * pytest's own collection replaces these guesses at Start; nothing here is
 * ever written back. File precedence (pytest 9, in the root): `pytest.toml`,
 * `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml`
 * (`[tool.pytest]` / `[tool.pytest.ini_options]`), `tox.ini` `[pytest]`,
 * `setup.cfg` `[tool:pytest]`.
 */
import * as fs from 'fs';
import * as path from 'path';

export type PytestOptions = Record<string, string | string[]>;

export interface PytestConfigFile {
  /** Absolute path of the file pytest uses. */
  file: string;
  /** The table / section the options came from. */
  section: string;
  options: PytestOptions;
}

/** pytest's defaults. */
export const DEFAULT_PYTHON_FILES = ['test_*.py', '*_test.py'];

/** The config files pytest reads, in its own order (the first that applies wins). */
export const PYTEST_CONFIG_FILES = ['pytest.toml', '.pytest.toml', 'pytest.ini', '.pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'];

/** The project's pytest config file in `root`, or undefined when there is none. */
export function findPytestConfig(root: string): PytestConfigFile | undefined {
  for (const name of PYTEST_CONFIG_FILES) {
    const file = path.join(root, name);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const found = readConfigText(name, text);
    if (found) { return { file, ...found }; }
  }
  return undefined;
}

/** The options of one config file's text, or undefined when it holds no pytest section. */
export function readConfigText(name: string, text: string): { section: string; options: PytestOptions } | undefined {
  switch (name) {
    case 'pytest.toml':
    case '.pytest.toml': {
      const t = parseTomlTables(text);
      return { section: 'pytest', options: t.get('pytest') ?? {} };
    }
    case 'pytest.ini':
    case '.pytest.ini': {
      // pytest.ini is used even without a [pytest] section.
      const s = parseIni(text);
      return { section: 'pytest', options: s.get('pytest') ?? {} };
    }
    case 'pyproject.toml': {
      const t = parseTomlTables(text);
      if (t.has('tool.pytest.ini_options')) { return { section: 'tool.pytest.ini_options', options: t.get('tool.pytest.ini_options')! }; }
      if (t.has('tool.pytest')) { return { section: 'tool.pytest', options: t.get('tool.pytest')! }; }
      return undefined;
    }
    case 'tox.ini': {
      const s = parseIni(text);
      return s.has('pytest') ? { section: 'pytest', options: s.get('pytest')! } : undefined;
    }
    case 'setup.cfg': {
      const s = parseIni(text);
      return s.has('tool:pytest') ? { section: 'tool:pytest', options: s.get('tool:pytest')! } : undefined;
    }
  }
  return undefined;
}

/** A list option: an array as is, an INI value split on whitespace / newlines. */
export function listOption(options: PytestOptions | undefined, key: string): string[] | undefined {
  const v = options?.[key];
  if (v === undefined) { return undefined; }
  return Array.isArray(v) ? v : v.split(/\s+/).filter(Boolean);
}

/** `addopts` as arguments (a TOML array as is, an INI string shell-split). */
export function addopts(options: PytestOptions | undefined): string[] {
  const v = options?.addopts;
  if (v === undefined) { return []; }
  return Array.isArray(v) ? v.flatMap(splitArgs) : splitArgs(v);
}

/** What our runs need to know from the config. */
export interface PytestSettings {
  configFile?: string;
  pythonFiles: string[];
  /** `python_classes` (prefixes or globs). */
  pythonClasses: string[];
  /** `python_functions` (prefixes or globs). */
  pythonFunctions: string[];
  testpaths: string[];
  /** pytest's `pythonpath` option (folders put on sys.path, relative to the rootdir). */
  pythonpath: string[];
  addopts: string[];
}

export function pytestSettings(root: string): PytestSettings {
  const cfg = findPytestConfig(root);
  return {
    configFile: cfg?.file,
    pythonFiles: listOption(cfg?.options, 'python_files') ?? DEFAULT_PYTHON_FILES,
    pythonClasses: listOption(cfg?.options, 'python_classes') ?? ['Test'],
    pythonFunctions: listOption(cfg?.options, 'python_functions') ?? ['test'],
    testpaths: listOption(cfg?.options, 'testpaths') ?? [],
    pythonpath: listOption(cfg?.options, 'pythonpath') ?? [],
    addopts: addopts(cfg?.options),
  };
}

/** Files that say "this project uses pytest" without configuring it. */
const MENTION_FILES = ['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'Pipfile', 'requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];

/**
 * True when `root` is a pytest project: a pytest config, a root
 * `conftest.py`, or pytest named in the project's dependency files with
 * test files where pytest looks by default (the root or `tests/` / `test/`).
 */
export function isPytestProject(root: string): boolean {
  if (findPytestConfig(root)) { return true; }
  if (fs.existsSync(path.join(root, 'conftest.py'))) { return true; }
  const mentions = MENTION_FILES.some((name) => {
    try { return /\bpytest\b/i.test(fs.readFileSync(path.join(root, name), 'utf8')); } catch { return false; }
  });
  if (!mentions) { return false; }
  return [root, path.join(root, 'tests'), path.join(root, 'test')].some((dir) => hasTestFile(dir));
}

function hasTestFile(dir: string): boolean {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((n) => /^test_.*\.py$|_test\.py$/.test(n))
    || names.some((n) => !n.startsWith('.') && isDir(path.join(dir, n)) && safeList(path.join(dir, n)).some((m) => /^test_.*\.py$|_test\.py$/.test(m)));
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Small parsers (only what pytest options use) ─────────────────────────────

/** INI as pytest's iniconfig reads it: sections, `key = value`, indented continuation lines, `#` / `;` comments. */
export function parseIni(text: string): Map<string, PytestOptions> {
  const sections = new Map<string, PytestOptions>();
  let current: PytestOptions | undefined;
  let lastKey: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw) || !raw.trim()) { continue; }
    const sec = /^\[([^\]]+)\]/.exec(raw);
    if (sec) {
      current = {};
      sections.set(sec[1].trim(), current);
      lastKey = undefined;
      continue;
    }
    if (!current) { continue; }
    if (/^\s/.test(raw) && lastKey) {
      current[lastKey] = `${current[lastKey] as string}\n${raw.trim()}`.trim();
      continue;
    }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(raw);
    if (kv) {
      lastKey = kv[1].trim();
      current[lastKey] = kv[2].trim();
    }
  }
  return sections;
}

/**
 * The tables of a TOML file with their string / string-array values — the
 * subset pytest options use (other values are kept as their raw text).
 */
export function parseTomlTables(text: string): Map<string, PytestOptions> {
  const tables = new Map<string, PytestOptions>();
  let current: PytestOptions | undefined;
  let i = 0;
  const lines = text.split(/\r?\n/);
  while (i < lines.length) {
    const line = stripTomlComment(lines[i]).trim();
    i++;
    if (!line) { continue; }
    const header = /^\[\s*([^\][]+?)\s*\]$/.exec(line);
    if (header) {
      const name = header[1].split('.').map((p) => p.trim().replace(/^["']|["']$/g, '')).join('.');
      current = tables.get(name) ?? {};
      tables.set(name, current);
      continue;
    }
    if (/^\[\[/.test(line)) { current = undefined; continue; }
    const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line);
    if (!kv || !current) { continue; }
    const key = kv[1].replace(/^["']|["']$/g, '');
    let value = kv[2];
    if (value.startsWith('[')) {
      // Arrays may span lines; collect until the brackets balance (outside strings).
      while (!arrayClosed(value) && i < lines.length) { value += '\n' + stripTomlComment(lines[i]); i++; }
      current[key] = tomlStrings(value);
    } else if (value.startsWith('"""') || value.startsWith("'''")) {
      const q = value.slice(0, 3);
      let body = value.slice(3);
      while (!body.includes(q) && i < lines.length) { body += '\n' + lines[i]; i++; }
      current[key] = body.slice(0, body.indexOf(q)).replace(/^\n/, '');
    } else {
      const s = tomlStrings(value);
      current[key] = s.length === 1 && /^["']/.test(value) ? s[0] : value.trim();
    }
  }
  return tables;
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) { quote = undefined; }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function arrayClosed(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) { quote = undefined; }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) { return true; }
    }
  }
  return false;
}

/** Every string literal in a TOML value (basic strings with escapes, literal strings as is). */
function tomlStrings(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m[1] !== undefined ? unescapeBasic(m[1]) : m[2]);
  }
  return out;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

/** Shell-style split (quotes and backslashes), as pytest splits an INI `addopts`. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { quote = undefined; continue; }
      if (c === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) { out.push(cur); }
  return out;
}
