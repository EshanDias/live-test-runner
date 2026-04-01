import { TestRunner, TestResult } from './TestRunner';
export declare class JestRunner implements TestRunner {
    private jestCommand;
    constructor(jestCommand?: string);
    discoverTests(projectRoot: string): Promise<string[]>;
    runFullSuite(projectRoot: string, withCoverage?: boolean): Promise<TestResult>;
    runTestFile(filePath: string): Promise<TestResult>;
    runTestFiles(files: string[]): Promise<TestResult>;
    runRelatedTests(filePath: string): Promise<TestResult>;
    isTestFile(filePath: string): boolean;
    getCoverage(): Promise<any>;
    killProcesses(): void;
    private runJest;
}
//# sourceMappingURL=JestRunner.d.ts.map