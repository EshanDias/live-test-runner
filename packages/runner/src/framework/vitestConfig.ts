import * as fs from 'fs';
import * as path from 'path';
import { readPackageJson } from './adapters/JestAdapter';
import { tokenize } from './jestConfig';

/** What the project's `test` script tells Vitest, so our runs match `npm test`. */
export interface VitestScriptArgs {
  /** `--config` / `-c` from the script, as an absolute path that exists. */
  config?: string;
  /** Other config-relevant flags, one token each (`--project=unit`, `--globals`). */
  args: string[];
}

/** Flags that take a value and change which tests run or how they are set up. */
const VALUE_FLAGS: Record<string, string> = {
  '--config': '--config', '-c': '--config',
  '--project': '--project',
  '--root': '--root', '-r': '--root',
  '--dir': '--dir',
  '--mode': '--mode',
  '--environment': '--environment',
};
const BOOLEAN_FLAGS = new Set(['--globals', '--dom', '--isolate', '--no-isolate']);
/** Subcommands that run tests. Anything else after `vitest` (bench, list, init…) is not a test run. */
const TEST_SUBCOMMANDS = new Set(['run', 'watch', 'dev']);
const OTHER_SUBCOMMANDS = new Set(['bench', 'list', 'init', 'related', 'typecheck']);
const SEPARATORS = /^(&&|\|\||\||;)$/;
const MAX_DEPTH = 3;

/**
 * Reads the `test` script (following `nr x`, `npm run x`, `pnpm x`, `yarn x`,
 * `bun run x` into other scripts, with their extra args) up to the `vitest`
 * call, and returns its config-relevant flags. Positional filters are
 * ignored: a full run covers what the extension discovers.
 *
 *   "nr test:unit --project=server" + "test:unit": "vitest --project unit"
 *     → { args: ['--project=unit', '--project=server'] }
 */
export function testScriptVitestArgs(projectRoot: string): VitestScriptArgs {
  const scripts = readPackageJson(projectRoot)?.scripts as Record<string, unknown> | undefined;
  const tokens = scripts ? findVitestCall(scripts, 'test', [], 0) : undefined;
  if (!tokens) { return { args: [] }; }

  const out: VitestScriptArgs = { args: [] };
  let sawSubcommand = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) {
      if (!sawSubcommand && OTHER_SUBCOMMANDS.has(tok)) { return { args: [] }; }
      if (!sawSubcommand && TEST_SUBCOMMANDS.has(tok)) { sawSubcommand = true; }
      continue; // a positional filter
    }
    sawSubcommand = true;
    const eq = tok.indexOf('=');
    const [flag, inline] = eq > 0 ? [tok.slice(0, eq), tok.slice(eq + 1)] : [tok, undefined];
    if (BOOLEAN_FLAGS.has(flag)) {
      out.args.push(tok);
    } else if (VALUE_FLAGS[flag]) {
      const value = inline ?? tokens[++i];
      if (value === undefined) { break; }
      const long = VALUE_FLAGS[flag];
      if (long === '--config') {
        const abs = path.resolve(projectRoot, value);
        if (fs.existsSync(abs)) { out.config = abs; }
      } else {
        out.args.push(`${long}=${value}`);
      }
    }
  }
  return out;
}

/** Tokens after `vitest` in `scripts[name]` (plus `extra`), or undefined if it never calls Vitest. */
function findVitestCall(
  scripts: Record<string, unknown>,
  name: string,
  extra: string[],
  depth: number,
): string[] | undefined {
  const script = scripts[name];
  if (typeof script !== 'string' || depth > MAX_DEPTH) { return undefined; }

  for (const segment of splitSegments(tokenize(script))) {
    const vi = segment.findIndex((t) => /(^|[\\/])vitest(\.m?js|\.cmd)?$/i.test(t));
    if (vi >= 0) { return [...segment.slice(vi + 1), ...extra]; }

    const inner = scriptReference(segment, scripts);
    if (inner) {
      const found = findVitestCall(scripts, inner.name, [...inner.rest, ...extra], depth + 1);
      if (found) { return found; }
    }
  }
  return undefined;
}

/** `nr x a`, `npm run x -- a`, `npm test`, `pnpm [run] x a`, `yarn [run] x a`, `bun run x a` → { name: x, rest: [a] }. */
function scriptReference(
  segment: string[],
  scripts: Record<string, unknown>,
): { name: string; rest: string[] } | undefined {
  // Skip leading env assignments (FOO=1) and cross-env.
  let i = 0;
  while (i < segment.length && (/^\w+=/.test(segment[i]) || segment[i] === 'cross-env')) { i++; }
  const [cmd, a, b] = segment.slice(i);
  let name: string | undefined;
  let restAt = 0;
  if (cmd === 'nr' && a) { name = a; restAt = i + 2; }
  else if ((cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') && (a === 'run' || a === 'run-script') && b) { name = b; restAt = i + 3; }
  else if (cmd === 'npm' && (a === 'test' || a === 't')) { name = 'test'; restAt = i + 2; }
  else if ((cmd === 'pnpm' || cmd === 'yarn') && a && typeof scripts[a] === 'string') { name = a; restAt = i + 2; }
  if (!name || typeof scripts[name] !== 'string') { return undefined; }
  const rest = segment.slice(restAt);
  return { name, rest: rest[0] === '--' ? rest.slice(1) : rest };
}

function splitSegments(tokens: string[]): string[][] {
  const out: string[][] = [[]];
  for (const t of tokens) {
    if (SEPARATORS.test(t)) { out.push([]); } else { out[out.length - 1].push(t); }
  }
  return out.filter((s) => s.length > 0);
}
