import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORK_IDS, FrameworkCapabilities, FrameworkId, RunResult } from '../../types';
import { FrameworkAdapter } from './FrameworkAdapter';
import { BinaryResolver } from '../../resolution/BinaryResolver';
import { testScriptJestArgs } from '../jestConfig';
import { ResultParser } from '../../parsing/ResultParser';
import { RunnerOptions, TestRunner } from '../../TestRunner';
import { JestRunner } from '../../JestRunner';

/** Config files Jest picks up from the project root. */
export const JEST_CONFIG_FILES = [
  'jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs',
  'jest.config.cts', 'jest.config.mts', 'jest.config.json',
];

/**
 * Handles standard Jest projects (plain Jest, Next.js with jest config, etc.).
 *
 * Detection: jest is present in dependencies/devDependencies and there is a
 * jest config (jest.config.* or package.json#jest) — OR jest is in deps with
 * no other framework taking priority.
 *
 * Config: jest discovers its own config; we return undefined from resolveConfig
 * and let jest handle it.
 *
 * Binary: node_modules/.bin/jest (local install).
 */
export class JestAdapter implements FrameworkAdapter {
  readonly framework: FrameworkId = FRAMEWORK_IDS.jest;

  private readonly binaryResolver = new BinaryResolver();

  detect(projectRoot: string): boolean {
    const pkg = readPackageJson(projectRoot);
    if (!pkg) return false;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const hasJest = 'jest' in deps;

    const hasJestConfig =
      JEST_CONFIG_FILES.some((f) => fs.existsSync(path.join(projectRoot, f))) ||
      pkg.jest !== undefined;

    if (!(hasJest || hasJestConfig)) { return false; }
    // The test script decides when it runs only Vitest and there is no Vitest
    // config to make the project a mixed one (svelte-testing-library keeps a
    // jest.config.js for a separate `test:jest`, but `npm test` is Vitest).
    return !testScriptRunsOnlyVitest(pkg.scripts?.test) || hasOwnVitestConfig(projectRoot);
  }

  resolveBinary(projectRoot: string): string {
    return this.binaryResolver.resolve(projectRoot);
  }

  async resolveConfig(_projectRoot: string): Promise<string | undefined> {
    // Jest discovers its own config — nothing to resolve.
    return undefined;
  }

  /**
   * Config-relevant flags from the project's `test` script (e.g.
   * `jest --config jest.unit.config.js --resetMocks`), so runs match `npm test`.
   */
  getExtraArgs(projectRoot: string): string[] {
    return testScriptJestArgs(projectRoot);
  }

  outputFileArg(file: string): string[] {
    return jestOutputFileArg(file);
  }

  parseResult(passed: boolean, raw: string, stderr: string): RunResult {
    return parseJestResult(passed, raw, stderr);
  }

  capabilities(_projectRoot: string): FrameworkCapabilities {
    return { ...JEST_CAPABILITIES };
  }

  createRunner(options?: RunnerOptions): TestRunner {
    return createJestRunner(options);
  }
}

// ── Shared by every Jest-based adapter (plain Jest, CRA) ───────────────────────

const jestParser = new ResultParser();

/** Everything the extension does today is built on Jest. */
export const JEST_CAPABILITIES: Readonly<FrameworkCapabilities> = {
  results: true, nameFilter: true, listTests: true, related: true, liveStream: true, coverage: true,
};

/** Jest writes its `--json` result to the file named by `--outputFile`. */
export function jestOutputFileArg(file: string): string[] {
  return [`--outputFile=${file}`];
}

/** Parses a `jest --json` result. */
export function parseJestResult(passed: boolean, raw: string, stderr: string): RunResult {
  return jestParser.parse(passed, raw, stderr);
}

/** A JestRunner — it detects plain Jest vs CRA per project root itself. */
export function createJestRunner(options: RunnerOptions = {}): TestRunner {
  return new JestRunner(options.command ?? '', options.logger, options.tmpDir);
}

// ── Shared utility ─────────────────────────────────────────────────────────────

export function readPackageJson(projectRoot: string): Record<string, any> | undefined {
  const p = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `scripts.test` runs Vitest and not Jest (`vitest run --coverage`; not `vitest run && jest`). */
export function testScriptRunsOnlyVitest(script: unknown): boolean {
  const s = String(script ?? '');
  return /(^|[\s;&|(])vitest(\s|$)/.test(s) && !/(^|[\s;&|(/])(jest|kcd-scripts\s+test|react-scripts\s+test)(\s|$)/.test(s);
}

/** A Vitest config file of the root's own (vitest.config.* / vitest.workspace.*) — with a Jest marker, a mixed project. */
function hasOwnVitestConfig(root: string): boolean {
  return ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].some((e) => fs.existsSync(path.join(root, `vitest.config.${e}`)))
    || ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].some((e) => fs.existsSync(path.join(root, `vitest.workspace.${e}`)));
}
