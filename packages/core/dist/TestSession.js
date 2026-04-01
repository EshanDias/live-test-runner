"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestSession = void 0;
const CoverageMap_1 = require("./CoverageMap");
class TestSession {
    constructor(runner) {
        this.isActive = false;
        this.runner = runner;
        this.coverageMap = new CoverageMap_1.CoverageMap();
    }
    async start(projectRoot) {
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
    stop() {
        this.isActive = false;
        this.runner.killProcesses();
    }
    isTestingActive() {
        return this.isActive;
    }
    async onSave(filePath, projectRoot) {
        if (!this.isActive) {
            return { passed: true, output: '', errors: [] };
        }
        if (this.runner.isTestFile(filePath)) {
            return await this.runner.runTestFile(filePath);
        }
        else {
            const affectedTests = this.coverageMap.getAffectedTests(filePath);
            if (affectedTests.size > 0) {
                return await this.runner.runTestFiles(Array.from(affectedTests));
            }
            else {
                return await this.runner.runRelatedTests(filePath);
            }
        }
    }
    getRunner() {
        return this.runner;
    }
    getCoverageMap() {
        return this.coverageMap;
    }
}
exports.TestSession = TestSession;
//# sourceMappingURL=TestSession.js.map