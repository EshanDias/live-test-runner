export interface TestRunner {
  discoverTests(projectRoot: string): Promise<string[]>;
  runFullSuite(projectRoot: string, withCoverage?: boolean): Promise<void>;
  runTestFile(filePath: string): Promise<void>;
  runTestFiles(files: string[]): Promise<void>;
  runRelatedTests(filePath: string): Promise<void>;
  isTestFile(filePath: string): boolean;
  getCoverage(): Promise<any>;
  killProcesses(): void;
}