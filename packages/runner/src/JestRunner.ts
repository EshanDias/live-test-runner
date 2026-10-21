import * as os from 'os';
import * as path from 'path';
import { CommandRunner, RunRequest } from './CommandRunner';
import { ExecutionResult } from './execution/Executor';
import { FrameworkDetector } from './framework/FrameworkDetector';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { ResultParser } from './parsing/ResultParser';
import { createLogger } from './utils/logger';
import { fromRunnerPath, toRunnerPath } from './resolution/RunnerPaths';

const log = createLogger('JestRunner');

/**
 * A file path as Jest expects it on the command line (--runTestsByPath,
 * --findRelatedTests). Jest realpaths its rootDir, so: the real path under a
 * symlinked project root (see RunnerPaths), forward slashes, and an upper-case
 * drive letter on Windows.
 */
export function toJestPathArg(filePath: string): string {
  return toRunnerPath(filePath)
    .replace(/\\/g, '/')
    .replace(/^([a-z]):\//, (_, d: string) => `${d.toUpperCase()}:/`);
}

/**
 * JestRunner — the TestRunner for Jest-based projects (plain Jest and CRA).
 *
 * Only the Jest command lines live here; detection, binary/config resolution,
 * chunking and process handling are in CommandRunner, the per-project
 * specifics in the adapters (JestAdapter, CRAAdapter), JSON parsing in
 * ResultParser.
 */
export class JestRunner extends CommandRunner {
  protected readonly runnerName = 'JestRunner';
  private readonly parser = new ResultParser();
  private readonly detector = new FrameworkDetector();

  /** Plain Jest or Create React App — whichever the project is. */
  protected detectAdapter(projectRoot: string): FrameworkAdapter {
    return this.detector.detect(projectRoot);
  }

  protected buildArgs(request: RunRequest): string[] {
    const base = this.baseArgs();
    switch (request.kind) {
      case 'list':
        log.debug('Listing tests with jest --listTests');
        return [...base, '--listTests', '--passWithNoTests'];
      case 'full':
        return [
          ...base,
          '--json',
          ...(request.withCoverage
            ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary']
            : []),
        ];
      case 'files':
        return [...base, '--json', '--runTestsByPath', ...request.files.map(toJestPathArg)];
      case 'testCase':
        return [
          ...base,
          '--json',
          '--runTestsByPath',
          toJestPathArg(request.file),
          '--testNamePattern',
          // Group the pattern: callers may pass several names joined with "|",
          // and ^a|b$ would mean "starts with a OR ends with b".
          // A suite matches its tests ("Suite test name"), so it ends at a space.
          request.isTestSuite
            ? `^(?:${request.testFullName})(?: |$)`
            : `^(?:${request.testFullName})$`,
        ];
      case 'related':
        return [...base, '--json', '--findRelatedTests', toJestPathArg(request.file)];
    }
  }

  protected parseTestList(result: ExecutionResult, projectRoot: string): string[] {
    // A config validation error means Jest rejected the config file entirely.
    // The output contains error prose, not file paths — abort immediately so we
    // don't parse Jest's error text as test file paths (Bug 3).
    if (!result.passed && this.isJestValidationError(result.stderr)) {
      const err = new Error(`[JestRunner] Jest config validation failed:\n${result.stderr.trim()}`);
      log.error(`Jest rejected the project config in ${projectRoot}:\n${result.stderr.trim()}`);
      throw err;
    }
    const found = this.parser
      .parseListTestsOutput(result.stdout + '\n' + result.stderr)
      .map(fromRunnerPath);
    if (found.length > 0) {
      log.debug(`--listTests found ${found.length} test file(s)`);
    }
    return found;
  }

  protected coverageFile(projectRoot: string): string {
    return path.join(projectRoot, 'coverage', 'coverage-final.json');
  }

  /** Args that every Jest invocation needs regardless of framework or mode. */
  private baseArgs(): string[] {
    // Cap Jest's internal worker count so multiple concurrent Jest processes
    // (controlled by CONCURRENCY in SessionManager) don't saturate all CPUs.
    // Formula: leave at least half the cores free for the OS + extension host.
    const cpus = os.cpus().length;
    const maxWorkers = Math.max(1, Math.floor(cpus / 4));
    return [
      '--watchAll=false', // prevent Jest from entering watch mode
      '--forceExit', // prevent Jest from hanging after completion
      '--no-bail', // always run all tests, never stop on first failure
      '--testLocationInResults', // populate location.line in JSON output (needed for gutter decorations)
      `--maxWorkers=${maxWorkers}`,
    ];
  }

  private isJestValidationError(stderr: string): boolean {
    return (
      stderr.includes('Validation Error') ||
      stderr.includes('Unknown option') ||
      stderr.includes('https://jestjs.io/docs/configuration')
    );
  }
}
