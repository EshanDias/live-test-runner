"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JestRunner = void 0;
const child_process_1 = require("child_process");
class JestRunner {
    constructor(jestCommand = 'npx jest') {
        this.jestCommand = jestCommand;
    }
    async discoverTests(projectRoot) {
        return new Promise((resolve, reject) => {
            const [cmd, ...args] = this.jestCommand.split(' ');
            const child = (0, child_process_1.spawn)(cmd, [...args, '--listTests'], { cwd: projectRoot });
            let output = '';
            child.stdout.on('data', (data) => {
                output += data.toString();
            });
            child.on('close', (code) => {
                if (code === 0) {
                    const files = output.trim().split('\n').filter(line => line.trim());
                    resolve(files);
                }
                else {
                    reject(new Error(`Jest listTests failed with code ${code}`));
                }
            });
            child.on('error', reject);
        });
    }
    async runFullSuite(projectRoot, withCoverage = false) {
        const args = withCoverage ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary'] : [];
        return this.runJest(args, projectRoot);
    }
    async runTestFile(filePath) {
        return this.runJest([filePath]);
    }
    async runTestFiles(files) {
        return this.runJest(files);
    }
    async runRelatedTests(filePath) {
        return this.runJest(['--findRelatedTests', filePath]);
    }
    isTestFile(filePath) {
        // Use patterns from settings, but for now simple check
        return filePath.includes('.test.') || filePath.includes('.spec.');
    }
    async getCoverage() {
        // Read the coverage file generated
        // Simplified: assume coverage/coverage.json exists
        const fs = require('fs');
        const path = require('path');
        const coveragePath = path.join(process.cwd(), 'coverage', 'coverage.json');
        if (fs.existsSync(coveragePath)) {
            return JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
        }
        return {};
    }
    killProcesses() {
        // Kill any running jest processes
        // Simplified: in real impl, track PIDs
    }
    async runJest(args, cwd) {
        return new Promise((resolve) => {
            const [cmd, ...cmdArgs] = this.jestCommand.split(' ');
            const child = (0, child_process_1.spawn)(cmd, [...cmdArgs, ...args], { cwd });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            child.on('close', (code) => {
                const passed = code === 0;
                const output = stdout + stderr;
                const errors = passed ? [] : [stderr || `Jest exited with code ${code}`];
                resolve({
                    passed,
                    output,
                    errors
                });
            });
            child.on('error', (error) => {
                resolve({
                    passed: false,
                    output: '',
                    errors: [error.message]
                });
            });
        });
    }
}
exports.JestRunner = JestRunner;
//# sourceMappingURL=JestRunner.js.map