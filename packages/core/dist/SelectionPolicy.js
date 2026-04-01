"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectionPolicy = void 0;
class SelectionPolicy {
    static isTestFile(filePath, patterns) {
        // Check if file matches test patterns
        return patterns.some(pattern => {
            const regex = new RegExp(pattern.replace(/\*/g, '.*'));
            return regex.test(filePath);
        });
    }
    static getRelatedTests(filePath) {
        // Fallback logic for finding related tests
        // For now, simple heuristic: replace .ts with .test.ts etc.
        const base = filePath.replace(/\.(ts|js)$/, '');
        return [`${base}.test.ts`, `${base}.spec.ts`];
    }
}
exports.SelectionPolicy = SelectionPolicy;
//# sourceMappingURL=SelectionPolicy.js.map