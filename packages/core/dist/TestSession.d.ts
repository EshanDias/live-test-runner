import { CoverageMap } from './CoverageMap';
import { TestRunner, TestResult } from '@live-test-runner/runner';
export declare class TestSession {
    private coverageMap;
    private runner;
    private isActive;
    constructor(runner: TestRunner);
    start(projectRoot: string): Promise<TestResult>;
    stop(): void;
    isTestingActive(): boolean;
    onSave(filePath: string, projectRoot: string): Promise<TestResult>;
    getRunner(): TestRunner;
    getCoverageMap(): CoverageMap;
}
//# sourceMappingURL=TestSession.d.ts.map