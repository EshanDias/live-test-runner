import { spawn } from 'child_process';
import { TestRunner, TestResult } from './TestRunner';
import * as fs from 'fs';
import * as path from 'path';

export class JestRunner implements TestRunner {
  private jestCommand: string;
  private useTestScript: boolean = false;

  constructor(jestCommand: string = 'node node_modules/jest/bin/jest.js') {
    this.jestCommand = jestCommand;
  }

  async discoverTests(projectRoot: string): Promise<string[]> {
    // Try to read package.json to see if there's a test script
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts && packageJson.scripts.test) {
          this.useTestScript = true;
        }
      } catch (e) {
        // Ignore
      }
    }

    if (this.useTestScript) {
      // For projects with test scripts, scan filesystem for test files
      return this.discoverTestsFromFilesystem(projectRoot);
    } else {
      // Use direct Jest
      return this.discoverTestsWithJest(projectRoot);
    }
  }

  private async discoverTestsWithJest(projectRoot: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = this.jestCommand.split(' ');
      const child = spawn(cmd, [...args, '--listTests'], { cwd: projectRoot, shell: true });

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

  private async discoverTestsFromFilesystem(projectRoot: string): Promise<string[]> {
    const testFiles: string[] = [];
    
    function scanDir(dir: string) {
      try {
        const items = fs.readdirSync(path.join(projectRoot, dir));
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const itemPath = path.join(projectRoot, fullPath);
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules' && item !== 'build' && item !== 'dist') {
            scanDir(fullPath);
          } else if (stat.isFile() && (item.includes('.test.') || item.includes('.spec.'))) {
            testFiles.push(itemPath);
          }
        }
      } catch (e) {
        // Ignore permission errors etc.
      }
    }
    
    scanDir('');
    return testFiles;
  }

  async runFullSuite(projectRoot: string, withCoverage: boolean = false): Promise<TestResult> {
    if (this.useTestScript) {
      // For test scripts, run without additional args to avoid config conflicts
      return this.runJest([], projectRoot);
    } else {
      const args = withCoverage ? ['--coverage', '--coverageReporters=json', '--coverageReporters=json-summary'] : [];
      return this.runJest(args, projectRoot);
    }
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
      let cmd: string;
      let cmdArgs: string[];

      if (this.useTestScript) {
        // Use npm run test -- <args>
        cmd = 'npm';
        cmdArgs = ['run', 'test', '--', ...args];
      } else {
        // Use direct jest command
        [cmd, ...cmdArgs] = this.jestCommand.split(' ');
        cmdArgs = [...cmdArgs, ...args];
      }

      const child = spawn(cmd, cmdArgs, { cwd, shell: true });

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
        const errors = passed ? [] : [stderr || `Test failed with code ${code}`];

        resolve({
          passed,
          output,
          errors
        });
      });

      child.on('error', (err) => {
        resolve({
          passed: false,
          output: '',
          errors: [err.message]
        });
      });
    });
  }
}