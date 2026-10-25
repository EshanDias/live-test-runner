import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPackageJson } from './adapters/JestAdapter';

/**
 * Helpers for working with a project's Jest configuration as Jest itself
 * resolved it (`jest --showConfig`), so every config format works the same:
 * jest.config.{js,cjs,mjs,ts,json}, package.json#jest, function / async
 * exports, presets, `--config` in the test script, and multi-project setups.
 */

/** Keys in a normalized (--showConfig) project config that Jest rejects as input. */
const NORMALIZED_ONLY_KEYS: ReadonlySet<string> = new Set(['cwd', 'name', 'id']);

/**
 * Global-config options that matter for running tests and must survive when
 * the project config is rebuilt from --showConfig output.
 */
export const GLOBAL_KEYS_TO_KEEP = [
  'globalSetup',
  'globalTeardown',
  'testTimeout',
  'testSequencer',
  'maxConcurrency',
] as const;

/**
 * Converts one normalized project config (from --showConfig) back into input
 * form: drops internal keys and turns Jest's array-of-tuples `transform` /
 * `moduleNameMapper` into the object form `--config` accepts. Transformer
 * options are kept: `[pattern, path, options]` → `{ pattern: [path, options] }`.
 */
export function toInputConfig(
  normalized: Record<string, unknown>,
  dropKeys: Iterable<string> = [],
): Record<string, unknown> {
  const drop = new Set([...NORMALIZED_ONLY_KEYS, ...dropKeys]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (drop.has(key)) { continue; }
    if (key === 'transform') {
      result[key] = tuplesToObject(value, true);
    } else if (key === 'moduleNameMapper') {
      result[key] = tuplesToObject(value, false);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function tuplesToObject(value: unknown, keepOptions: boolean): unknown {
  if (!Array.isArray(value) || !value.every((item) => Array.isArray(item) && item.length >= 2)) {
    return value;
  }
  return Object.fromEntries(
    (value as unknown[][]).map(([pattern, target, options]) => {
      const hasOptions = keepOptions && options !== undefined &&
        !(typeof options === 'object' && options !== null && Object.keys(options).length === 0);
      return [pattern as string, hasOptions ? [target, options] : target];
    }),
  );
}

/**
 * Picks the global options worth keeping from a --showConfig `globalConfig`.
 */
export function pickGlobalConfig(globalConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!globalConfig) { return out; }
  for (const key of GLOBAL_KEYS_TO_KEEP) {
    if (globalConfig[key] !== undefined && globalConfig[key] !== null) { out[key] = globalConfig[key]; }
  }
  return out;
}

/** Jest flags from the project's `test` script that change how tests behave. */
const VALUE_FLAGS = new Set(['--config', '-c', '--env', '--testEnvironment', '--rootDir', '--testTimeout']);
const BOOLEAN_FLAGS = new Set([
  '--resetMocks', '--clearMocks', '--restoreMocks', '--resetModules', '--automock',
]);

/**
 * The config-relevant Jest arguments in package.json `scripts.test`, so runs
 * behave like `npm test`: e.g. `react-scripts test --resetMocks` or
 * `jest --config jest.unit.config.js`. Flags that only affect how Jest runs
 * (watch, coverage, bail, reporters…) are ignored. `--config` paths are made
 * absolute.
 */
export function testScriptJestArgs(projectRoot: string): string[] {
  const script = readPackageJson(projectRoot)?.scripts?.test;
  if (typeof script !== 'string') { return []; }

  const tokens = tokenize(script);
  let i = tokens.findIndex((t, idx) =>
    /(^|[\\/])jest(\.js|\.cmd)?$/i.test(t) ||
    (/(^|[\\/])react-scripts(\.js|\.cmd)?$/i.test(t) && tokens[idx + 1] === 'test'),
  );
  if (i < 0) { return []; }
  i += /react-scripts/i.test(tokens[i]) ? 2 : 1;

  const args: string[] = [];
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^(&&|\|\||\||;)$/.test(tok)) { break; }
    const [flag, inline] = tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, undefined];
    if (BOOLEAN_FLAGS.has(flag)) {
      args.push(tok);
    } else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? tokens[++i];
      if (value === undefined) { break; }
      const isConfig = flag === '--config' || flag === '-c';
      const resolved = isConfig && !value.trim().startsWith('{') && !path.isAbsolute(value)
        ? path.resolve(projectRoot, value)
        : value;
      if (isConfig && !value.trim().startsWith('{') && !fs.existsSync(resolved)) { continue; }
      args.push(isConfig ? '--config' : flag, resolved);
    }
  }
  return args;
}

/**
 * Node options the project's `test` script gives Jest — `NODE_OPTIONS=…
 * jest`, `cross-env NODE_OPTIONS=… jest`, `node --flag node_modules/.bin/jest`:
 * most often `--experimental-vm-modules` (Jest's ESM mode — ES-module
 * projects, Svelte 4+ through svelte-jester). Only flags Node accepts in
 * NODE_OPTIONS and that change how test code loads are kept.
 */
export function testScriptNodeOptions(projectRoot: string, home: string = os.homedir()): string[] {
  const script = readPackageJson(projectRoot)?.scripts?.test;
  if (typeof script !== 'string') { return []; }
  const fromScript = scriptNodeFlags(script);
  if (fromScript === undefined) { return []; }
  // npm / pnpm also pass `node-options` from .npmrc to `npm test`.
  const flags = [...fromScript, ...npmrcNodeOptions(projectRoot, home)];
  return [...new Set(flags.filter((f) => NODE_FLAG_RE.test(f)))];
}

/**
 * `node-options` from .npmrc, as npm applies it to `npm test`: the project's
 * (the root, or the monorepo root above it), else the user's (~/.npmrc).
 */
export function npmrcNodeOptions(projectRoot: string, home: string = os.homedir()): string[] {
  const candidates = [path.join(path.resolve(projectRoot), '.npmrc')];
  // Folders above that are packages too (a monorepo root), up to the repository root.
  let dir = path.resolve(projectRoot);
  for (let i = 0; i < 8 && !fs.existsSync(path.join(dir, '.git')); i++) {
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
    if (fs.existsSync(path.join(dir, 'package.json'))) { candidates.push(path.join(dir, '.npmrc')); }
  }
  if (home) { candidates.push(path.join(home, '.npmrc')); }
  for (const file of candidates) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) { continue; }
      const m = /^node[-_]options\s*=\s*(.*)$/i.exec(line);
      if (m) { return m[1].trim().replace(/^(["'])(.*)\1$/, '$2').split(/\s+/).filter(Boolean); }
    }
  }
  return [];
}

/** Node flags in the command that runs Jest; undefined when the script does not run Jest. */
function scriptNodeFlags(script: string): string[] | undefined {
  const tokens = tokenize(script);
  const jestAt = tokens.findIndex((t, idx) =>
    /(^|[\\/])jest(\.js|\.cmd)?$/i.test(t) ||
    (/(^|[\\/])react-scripts(\.js|\.cmd)?$/i.test(t) && tokens[idx + 1] === 'test'),
  );
  if (jestAt < 0) { return undefined; }
  // The words of the command that runs Jest: back to the previous && / ; / |.
  let start = jestAt;
  while (start > 0 && !/^(&&|\|\||\||;)$/.test(tokens[start - 1])) { start--; }
  const flags: string[] = [];
  let afterNode = false;
  for (let i = start; i < jestAt; i++) {
    const tok = tokens[i];
    const env = /^NODE_OPTIONS=(.*)$/.exec(tok);
    if (env) { flags.push(...env[1].split(/\s+/).filter(Boolean)); continue; }
    if (/(^|[\\/])node(\.exe)?$/i.test(tok)) { afterNode = true; continue; }
    if (afterNode && tok.startsWith('-')) { flags.push(tok); }
  }
  return flags;
}

/** Node flags kept from a test script (allowed in NODE_OPTIONS, about loading code). */
const NODE_FLAG_RE = /^--(?:experimental-vm-modules|experimental-[\w-]+|no-warnings|no-experimental-[\w-]+|enable-source-maps|conditions=\S+|import=\S+|require=\S+|(?:experimental-)?loader=\S+|max-old-space-size=\d+|stack-trace-limit=\d+)$/;

/**
 * Environment for a Jest process: the test script's Node options (see
 * {@link testScriptNodeOptions}) added to NODE_OPTIONS; undefined when none.
 */
export function jestNodeEnv(projectRoot: string, base: string | undefined = process.env.NODE_OPTIONS, home?: string): Record<string, string> | undefined {
  const flags = testScriptNodeOptions(projectRoot, home);
  if (flags.length === 0) { return undefined; }
  const have = (base ?? '').split(/\s+/).filter(Boolean);
  return { NODE_OPTIONS: [...have, ...flags.filter((f) => !have.includes(f))].join(' ') };
}

const ESM_LOAD_ERROR_RE = /Cannot use import statement outside a module|Unexpected token '?export'?|Must use import to load ES Module|require\(\) of ES Module|ERR_REQUIRE_ESM/;

/**
 * Why Jest could not load a file as an ES module, and what to change — or
 * undefined when the message is not about ES modules. `kind` lets callers
 * say each once per session.
 */
export function jestEsmHint(message: string, projectRoot: string, home?: string): { kind: 'esm-mode' | 'node-modules'; text: string } | undefined {
  if (!ESM_LOAD_ERROR_RE.test(message)) { return undefined; }
  const esmMode = testScriptNodeOptions(projectRoot, home).includes('--experimental-vm-modules');
  const fromPackage = /[\\/]node_modules[\\/]/.test(message);
  const flag = 'add NODE_OPTIONS=--experimental-vm-modules to the test script ("test": "NODE_OPTIONS=--experimental-vm-modules jest") '
    + 'or node-options=--experimental-vm-modules to .npmrc, then Start again (https://jestjs.io/docs/ecmascript-modules)';
  if (fromPackage) {
    return {
      kind: 'node-modules',
      text: 'a package in node_modules ships ES modules, which Jest does not transform by default — add it to transformIgnorePatterns '
        + 'in the Jest config (e.g. "/node_modules/(?!the-package)")' + (esmMode ? '' : `, or run Jest in its ESM mode: ${flag}`),
    };
  }
  if (esmMode) { return undefined; }
  return { kind: 'esm-mode', text: `Jest runs ES modules only in its ESM mode (npm test fails the same way) — ${flag}` };
}

/**
 * Splits a shell command line on whitespace. Quotes group words and may sit
 * inside a token (`--project="browser (chromium)"` → `--project=browser (chromium)`);
 * `&&`, `||`, `|`, `;` come out as their own tokens.
 */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) { quote = undefined; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch; has = true;
    }
  }
  if (has) { out.push(cur); }
  return out;
}
