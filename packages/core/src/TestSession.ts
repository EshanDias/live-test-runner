import { CoverageMap } from './CoverageMap';
import { TestRunner, TestResult } from '@live-test-runner/runner';

export class TestSession {
  private coverageMap: CoverageMap;
  private runner: TestRunner;
  private isActive: boolean = false;

  constructor(runner: TestRunner) {
    this.runner = runner;
    this.coverageMap = new CoverageMap();
  }

  async start(projectRoot: string): Promise<TestResult> {
    this.isActive = true;
    // Discover tests
    const testFiles = await this.runner.discoverTests(projectRoot);
    // Warm-up run with coverage
    const result = await this.runner.runFullSuite(projectRoot, true);
    // Build map only if tests passed
    if (result.passed) {
      this.coverageMap.buildFromCoverage(await this.runner.getCoverage());
    }
    return result;
  }

  stop(): void {
    this.isActive = false;
    this.runner.killProcesses();
  }

  isTestingActive(): boolean {
    return this.isActive;
  }

  /** Marks the session active without running a warmup. Used when the caller
   *  drives the warmup run directly (e.g. to get structured JSON results). */
  activate(): void {
    this.isActive = true;
  }

  async onSave(filePath: string, projectRoot: string): Promise<TestResult> {
    if (!this.isActive) {
      return { passed: true, output: '', errors: [] };
    }

    if (this.runner.isTestFile(filePath)) {
      return await this.runner.runTestFile(filePath);
    } else {
      const affectedTests = this.coverageMap.getAffectedTests(filePath);
      if (affectedTests.size > 0) {
        return await this.runner.runTestFiles(Array.from(affectedTests));
      } else {
        return await this.runner.runRelatedTests(filePath);
      }
    }
  }

  getRunner(): TestRunner {
    return this.runner;
  }

  getCoverageMap(): CoverageMap {
    return this.coverageMap;
  }
}