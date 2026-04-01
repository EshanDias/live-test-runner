export interface TestResult {
    passed: boolean;
    output: string;
    errors: string[];
}
export interface TestRunner {
    discoverTests(projectRoot: string): Promise<string[]>;
    runFullSuite(projectRoot: string, withCoverage?: boolean): Promise<TestResult>;
    runTestFile(filePath: string): Promise<TestResult>;
    runTestFiles(files: string[]): Promise<TestResult>;
    runRelatedTests(filePath: string): Promise<TestResult>;
    isTestFile(filePath: string): boolean;
    getCoverage(): Promise<any>;
    killProcesses(): void;
}
//# sourceMappingURL=TestRunner.d.ts.map