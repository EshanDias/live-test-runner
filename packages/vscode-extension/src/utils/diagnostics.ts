/**
 * diagnostics.ts — builds the "Copy Diagnostic Report" markdown.
 *
 * One place that answers the first questions of every bug report:
 * which versions, which project setup, which Jest binary/config, and what
 * the extension logged recently (debug level included, even when the log
 * channel is set to info).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FrameworkDetector, BinaryResolver } from '@live-test-runner/runner';

const JEST_CONFIG_FILES = [
  'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
  'jest.config.ts', 'jest.config.cts', 'jest.config.mts', 'jest.config.json',
];

const MAX_LOG_LINES = 300;

export interface DiagnosticInput {
  extensionVersion: string;
  projectRoot: string | undefined;
  sessionActive: boolean;
  sessionDir: string;
  summary: { total: number; passed: number; failed: number; running: number };
  logLevel: string;
  recentLogLines: string[];
}

function safe<T>(fn: () => T, fallback: string): T | string {
  try { return fn(); } catch (err) { return `${fallback} (${(err as Error).message})`; }
}

function readJson(file: string): Record<string, any> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function pkgVersion(name: string, root: string): string {
  try {
    const p = require.resolve(`${name}/package.json`, { paths: [root] });
    return readJson(p)?.version ?? 'unknown';
  } catch {
    return 'not installed';
  }
}

export function buildDiagnosticReport(input: DiagnosticInput): string {
  const lines: string[] = [];
  const add = (s = '') => lines.push(s);
  const row = (k: string, v: unknown) => add(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`);

  add('# Live Test Runner — Diagnostic Report');
  add();
  add(`Generated ${new Date().toISOString()}`);
  add();
  add('## Environment');
  add('| Item | Value |');
  add('|---|---|');
  row('Extension', input.extensionVersion);
  row('VS Code', vscode.version);
  row('OS', `${process.platform} ${process.arch}`);
  row('Extension host Node', process.versions.node);
  row('Log level', input.logLevel);
  add();

  add('## Project');
  add('| Item | Value |');
  add('|---|---|');
  const root = input.projectRoot;
  row('Project root', root ?? '(none — multi-root workspace without liveTestRunner.projectRoot?)');
  if (root) {
    const pkg = readJson(path.join(root, 'package.json'));
    row('package.json', pkg ? 'found' : 'MISSING');
    row('"test" script', pkg?.scripts?.test ?? '(none)');
    row('"jest" key in package.json', pkg?.jest ? 'yes' : 'no');
    const configs = JEST_CONFIG_FILES.filter((f) => fs.existsSync(path.join(root, f)));
    row('Jest config files', configs.join(', ') || '(none)');
    row('Detected framework', safe(() => new FrameworkDetector().detectFramework(root), 'error'));
    row('Jest binary', safe(() => new BinaryResolver().resolve(root), 'error'));
    row('jest', pkgVersion('jest', root));
    row('react-scripts', pkgVersion('react-scripts', root));
    row('ts-jest', pkgVersion('ts-jest', root));
    row('babel-jest', pkgVersion('babel-jest', root));
    row('@swc/jest', pkgVersion('@swc/jest', root));
  }
  add();

  add('## Session');
  add('| Item | Value |');
  add('|---|---|');
  row('Active', input.sessionActive);
  row('Tests (total / passed / failed / running)',
    `${input.summary.total} / ${input.summary.passed} / ${input.summary.failed} / ${input.summary.running}`);
  row('Session temp folder', input.sessionDir);
  add();

  add('## Settings (liveTestRunner.*)');
  add('```json');
  const cfg = vscode.workspace.getConfiguration('liveTestRunner');
  const keys = ['projectRoot', 'jestCommand', 'runMode', 'onSaveDebounceMs', 'testFilePatterns', 'devMode'];
  add(JSON.stringify(Object.fromEntries(keys.map((k) => [k, cfg.get(k)])), null, 2));
  add('```');
  add();

  const recent = input.recentLogLines.slice(-MAX_LOG_LINES);
  add(`## Recent log (last ${recent.length} lines, debug and above)`);
  add('```text');
  for (const l of recent) { add(l); }
  add('```');

  return lines.join('\n');
}
