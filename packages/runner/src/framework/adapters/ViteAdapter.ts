import { Framework } from '../../types';
import { FrameworkAdapter } from './FrameworkAdapter';
import { readPackageJson } from './JestAdapter';

/**
 * Stub adapter for Vitest / Vite projects.
 *
 * Detection works correctly — if a project uses Vitest this adapter is chosen.
 * All execution methods throw a clear "not yet supported" error so the user
 * gets actionable feedback rather than a cryptic failure.
 *
 * When Vitest support is implemented, replace the throw stubs with real logic
 * and this adapter slot is already wired in.
 */
export class ViteAdapter implements FrameworkAdapter {
  readonly framework: Framework = 'vite';

  detect(projectRoot: string): boolean {
    const pkg = readPackageJson(projectRoot);
    if (!pkg) return false;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    return 'vitest' in deps;
  }

  resolveBinary(_projectRoot: string): string {
    throw new UnsupportedFrameworkError('vite');
  }

  async resolveConfig(_projectRoot: string): Promise<string | undefined> {
    throw new UnsupportedFrameworkError('vite');
  }

  getExtraArgs(_projectRoot: string): string[] {
    throw new UnsupportedFrameworkError('vite');
  }
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class UnsupportedFrameworkError extends Error {
  constructor(framework: string) {
    super(
      `[Live Test Runner] The "${framework}" framework is not yet supported.\n` +
      'Only Jest and CRA (react-scripts) projects are supported in this version.\n' +
      'Follow https://github.com/EshanDias/live-test-runner for updates.',
    );
    this.name = 'UnsupportedFrameworkError';
  }
}
