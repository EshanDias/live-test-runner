import * as path from 'path';
import { pytestSettings } from '@live-test-runner/runner';
import { IProjectConfig } from './IProjectConfig';
import { CoverageScope } from '../coverage/coverageScope';
import { isExcludedFromCoverage } from '../coverage/coverageRules';

/**
 * The pytest config a project uses (pytest.toml / pytest.ini / pyproject.toml
 * / tox.ini / setup.cfg — see the runner's pytestConfig). pytest reads it
 * itself; this is the file path, for the log and for "config saved → restart".
 *
 * Coverage: coverage.py applies the project's own `[run] source / include /
 * omit` while measuring, so what it reports is what counts — minus test
 * files (and conftest.py), as Jest and Vitest leave tests out. Files no test
 * imported are reported by coverage.py itself when `source` is set, so there
 * is no source scan of our own (`includesUntouched: false`).
 */
export class PytestProjectConfig implements IProjectConfig {
  async get(projectRoot: string): Promise<string | undefined> {
    return pytestSettings(projectRoot).configFile;
  }

  async coverageScope(projectRoot: string): Promise<CoverageScope | undefined> {
    return {
      source: 'coverage.py settings (test files left out)',
      includesUntouched: false,
      isDefault: false,
      counts: (fp) => {
        const rel = path.relative(projectRoot, fp);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return false; }
        return !isExcludedFromCoverage(rel);
      },
    };
  }

  /** Saving a `.py` file reruns the tests that use it. */
  async sourceExtensions(): Promise<string[]> {
    return ['py', 'pyi'];
  }

  reset(): void { /* read fresh every call */ }
}
