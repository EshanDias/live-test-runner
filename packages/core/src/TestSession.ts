import { TestRunner } from '@live-test-runner/runner';

/**
 * Whether a project's session is on, and the runner it uses. The extension's
 * SessionManager drives the runs itself (activate / stop); on-save reruns are
 * chosen by the execution trace and the framework's related run.
 */
export class TestSession {
  private runner: TestRunner;
  private isActive: boolean = false;

  constructor(runner: TestRunner) {
    this.runner = runner;
  }

  stop(): void {
    this.isActive = false;
    this.runner.killProcesses();
  }

  isTestingActive(): boolean {
    return this.isActive;
  }

  /** Marks the session active; the caller drives the runs. */
  activate(): void {
    this.isActive = true;
  }

  getRunner(): TestRunner {
    return this.runner;
  }
}
