import { spawn } from 'child_process';
import { TestRunner } from './TestRunner';

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

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<void> {
    const args = withCoverage ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary'] : [];
    await this.runJest(args, projectRoot);
  }

  async runTestFile(filePath: string): Promise<void> {
    await this.runJest([filePath]);
  }

  async runTestFiles(files: string[]): Promise<void> {
    await this.runJest(files);
  }

  async runRelatedTests(filePath: string): Promise<void> {
    await this.runJest(['--findRelatedTests', filePath]);
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

  private async runJest(args: string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const [cmd, ...cmdArgs] = this.jestCommand.split(' ');
      const child = spawn(cmd, [...cmdArgs, ...args], { cwd });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Jest failed with code ${code}`));
        }
      });

      child.on('error', reject);
    });
  }
}