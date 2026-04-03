import { CoverageMap } from './CoverageMap';
import { TestRunner } from '@live-test-runner/runner';

export class TestSession {
  private coverageMap: CoverageMap;
  private runner: TestRunner;
  private isActive: boolean = false;

  constructor(runner: TestRunner) {
    this.runner = runner;
    this.coverageMap = new CoverageMap();
  }

  async start(projectRoot: string): Promise<void> {
    this.isActive = true;
    // Discover tests then do a warm-up run with coverage to build the map
    await this.runner.discoverTests(projectRoot);
    const result = await this.runner.runFullSuiteJson(projectRoot, true);
    if (result.passed) {
      this.coverageMap.buildFromCoverage(await this.runner.getCoverage());
    }
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

  getRunner(): TestRunner {
    return this.runner;
  }

  getCoverageMap(): CoverageMap {
    return this.coverageMap;
  }
}
