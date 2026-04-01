import { spawn } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';

export class JestRunner implements TestRunner {
  private jestCommand: string;

  constructor(jestCommand: string = 'npx jest') {
    this.jestCommand = jestCommand;
  }

  async discoverTests(projectRoot: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = this.jestCommand.split(' ');
      const child = spawn(cmd, [...args, '--listTests'], { cwd: projectRoot });

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          const files = output.trim().split('\n').filter(line => line.trim());
          resolve(files);
        } else {
          reject(new Error(`Jest listTests failed with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    const args = withCoverage ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary'] : [];
    return this.runJest(args, projectRoot);
  }

  async runTestFile(filePath: string): Promise<TestResult> {
    return this.runJest([filePath]);
  }

  async runTestFiles(files: string[]): Promise<TestResult> {
    return this.runJest(files);
  }

  async runRelatedTests(filePath: string): Promise<TestResult> {
    return this.runJest(['--findRelatedTests', filePath]);
  }

  isTestFile(filePath: string): boolean {
    // Use patterns from settings, but for now simple check
    return filePath.includes('.test.') || filePath.includes('.spec.');
  }

  async getCoverage(): Promise<any> {
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

  killProcesses(): void {
    // Kill any running jest processes
    // Simplified: in real impl, track PIDs
  }

  private async runJest(args: string[], cwd?: string): Promise<TestResult> {
    return new Promise((resolve) => {
      const [cmd, ...cmdArgs] = this.jestCommand.split(' ');
      const child = spawn(cmd, [...cmdArgs, ...args], { cwd });

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