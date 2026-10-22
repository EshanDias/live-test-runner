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
const JEST_CONFIG_FILES = [
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

    return hasJest || hasJestConfig;
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
