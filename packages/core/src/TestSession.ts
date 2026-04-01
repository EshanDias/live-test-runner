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
    // Discover tests
    const testFiles = await this.runner.discoverTests(projectRoot);
    // Warm-up run with coverage
    await this.runner.runFullSuite(projectRoot, true);
    // Build map
    this.coverageMap.buildFromCoverage(await this.runner.getCoverage());
  }

  stop(): void {
    this.isActive = false;
    this.runner.killProcesses();
  }

  isTestingActive(): boolean {
    return this.isActive;
  }

  async onSave(filePath: string, projectRoot: string): Promise<void> {
    if (!this.isActive) return;

    if (this.runner.isTestFile(filePath)) {
      await this.runner.runTestFile(filePath);
    } else {
      const affectedTests = this.coverageMap.getAffectedTests(filePath);
      if (affectedTests.size > 0) {
        await this.runner.runTestFiles(Array.from(affectedTests));
      } else {
        await this.runner.runRelatedTests(filePath);
      }
    }
  }

  getRunner(): TestRunner {
    return this.runner;
  }