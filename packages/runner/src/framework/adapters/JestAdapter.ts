import * as fs from 'fs';
import * as path from 'path';
import { Framework } from '../../types';
import { FrameworkAdapter } from './FrameworkAdapter';
import { BinaryResolver } from '../../resolution/BinaryResolver';

/**
 * Handles standard Jest projects (plain Jest, Next.js with jest config, etc.).
 *
 * Detection: jest is present in dependencies/devDependencies and there is a
 * jest config (jest.config.* or package.json#jest) — OR jest is in deps with
 * no other framework taking priority.
 *
 * Config: jest discovers its own config; we return undefined from resolveJestConfig
 * and let jest handle it.
 *
 * Binary: node_modules/.bin/jest (local install).
 */
export class JestAdapter implements FrameworkAdapter {
  readonly framework: Framework = 'jest';

  private readonly binaryResolver = new BinaryResolver();

  detect(projectRoot: string): boolean {
    const pkg = readPackageJson(projectRoot);
    if (!pkg) return false;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const hasJest = 'jest' in deps;

    const hasJestConfig =
      fs.existsSync(path.join(projectRoot, 'jest.config.js')) ||
      fs.existsSync(path.join(projectRoot, 'jest.config.ts')) ||
      fs.existsSync(path.join(projectRoot, 'jest.config.cjs')) ||
      fs.existsSync(path.join(projectRoot, 'jest.config.mjs')) ||
      pkg.jest !== undefined;

    return hasJest || hasJestConfig;
  }

  resolveJestBinary(projectRoot: string): string {
    return this.binaryResolver.resolve(projectRoot);
  }

  async resolveJestConfig(_projectRoot: string): Promise<string | undefined> {
    // Jest discovers its own config — nothing to resolve.
    return undefined;
  }

  getExtraArgs(_projectRoot: string): string[] {
    return [];
  }
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
