import * as fs from 'fs';
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
export function testScriptNodeOptions(projectRoot: string): string[] {
  const script = readPackageJson(projectRoot)?.scripts?.test;
  if (typeof script !== 'string') { return []; }
  const tokens = tokenize(script);
  const jestAt = tokens.findIndex((t, idx) =>
    /(^|[\\/])jest(\.js|\.cmd)?$/i.test(t) ||
    (/(^|[\\/])react-scripts(\.js|\.cmd)?$/i.test(t) && tokens[idx + 1] === 'test'),
  );
  if (jestAt < 0) { return []; }
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
  return [...new Set(flags.filter((f) => NODE_FLAG_RE.test(f)))];
}

/** Node flags kept from a test script (allowed in NODE_OPTIONS, about loading code). */
const NODE_FLAG_RE = /^--(?:experimental-vm-modules|experimental-[\w-]+|no-warnings|no-experimental-[\w-]+|enable-source-maps|conditions=\S+|import=\S+|require=\S+|(?:experimental-)?loader=\S+|max-old-space-size=\d+|stack-trace-limit=\d+)$/;

/**
 * Environment for a Jest process: the test script's Node options (see
 * {@link testScriptNodeOptions}) added to NODE_OPTIONS; undefined when none.
 */
export function jestNodeEnv(projectRoot: string, base: string | undefined = process.env.NODE_OPTIONS): Record<string, string> | undefined {
  const flags = testScriptNodeOptions(projectRoot);
  if (flags.length === 0) { return undefined; }
  const have = (base ?? '').split(/\s+/).filter(Boolean);
  return { NODE_OPTIONS: [...have, ...flags.filter((f) => !have.includes(f))].join(' ') };
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
