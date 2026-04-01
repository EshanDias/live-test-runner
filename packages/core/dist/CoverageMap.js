"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoverageMap = void 0;
class CoverageMap {
    constructor() {
        this.map = new Map();
    }
    buildFromCoverage(coverageData) {
        // Parse coverage JSON and build the map
        // coverageData is from Jest coverage reporter
        // For each source file, collect test files that cover it
        // This is simplified; in real implementation, parse the coverage report
        // Assuming coverageData has structure like { file: { coveredBy: [tests] } }
        for (const [sourceFile, data] of Object.entries(coverageData)) {
            const tests = data.coveredBy || [];
            this.map.set(sourceFile, new Set(tests));
        }
    }
    getAffectedTests(sourceFile) {
        return this.map.get(sourceFile) || new Set();
    }
    clear() {
        this.map.clear();
    }
}
exports.CoverageMap = CoverageMap;
//# sourceMappingURL=CoverageMap.js.map