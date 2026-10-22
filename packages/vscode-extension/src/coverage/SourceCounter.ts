/**
 * SourceCounter — background scan at session start.
 *
 * AST-parses the source files that count toward coverage but no test has
 * loaded yet, and counts statements, branches, functions, and executable
 * lines. Populates CoverageStore with 'counted' entries (state = 0 hits) so
 * untouched files are included in the denominator, giving correct aggregate
 * percentages.
 *
 * Which files count comes from the project's coverage settings
 * ({@link CoverageScope}), so the totals match the framework's CLI report:
 * when the config does not list the files to cover (no Vitest
 * `coverage.include` / Jest `collectCoverageFrom`), the CLI reports only the
 * files the tests loaded, and so there is nothing to scan.
 *
 * Mirrors TestDiscoveryService — fires and is forgotten, runs in parallel
 * with the first test run.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { loadBabelParser, loadTraverse } from '../utils/babel';
import { EventEmitter } from 'events';
import { CoverageStore } from './CoverageStore';
import { CoverageScope } from './coverageScope';
import { logger } from '../utils/logger';

const log = logger.scope('Coverage');

const YIELD_EVERY = 10;

export class SourceCounter extends EventEmitter {
  constructor(
    private readonly _projectRoot: string,
    private readonly _store: CoverageStore,
    /** Which files count — awaited, so the scan can start before the config is read. */
    private readonly _scope: CoverageScope | Promise<CoverageScope>,
  ) {
    super();
  }

  async run(): Promise<void> {
    const startedAt = Date.now();
    const scope = await this._scope;
    if (!scope.includesUntouched) {
      log.debug(`Coverage counts only the files the tests load (${scope.source} — no include list) — no source scan`);
      this._store.markScanComplete();
      this.emit('done');
      return;
    }

    const include = new vscode.RelativePattern(this._projectRoot, '**/*.{js,ts,jsx,tsx}');
    // Flattened — no nested braces, VS Code glob doesn't support them reliably.
    // With the project's own rules, only what can never count is left out here; the scope decides the rest.
    const defaultExcludeParts = scope.isDefault ? [
      '**/node_modules/**',
      '**/*.test.js', '**/*.test.ts', '**/*.test.jsx', '**/*.test.tsx',
      '**/*.spec.js', '**/*.spec.ts', '**/*.spec.jsx', '**/*.spec.tsx',
      '**/__tests__/**', '**/__mocks__/**',
      '**/tests/**', '**/test/**', '**/specs/**', '**/spec/**',
      '**/*.config.js', '**/*.config.ts', '**/*.config.mjs', '**/*.config.cjs',
      '**/*.d.ts',
      'dist/**', 'build/**', 'out/**', '.next/**', 'coverage/**',
    ] : ['**/node_modules/**', '**/.git/**'];
    const userExclude = vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<string[]>('coverageExclude', []);
    const allExcludeParts = userExclude.length > 0
      ? [...defaultExcludeParts, ...userExclude]
      : defaultExcludeParts;
    const excludeGlob = `{${allExcludeParts.join(',')}}`;

    let files: string[];
    try {
      const uris = await vscode.workspace.findFiles(include, excludeGlob);
      files = uris.map((u) => u.fsPath).filter((fp) => scope.counts(fp));
    } catch (err) {
      log.error('Source file scan failed — coverage totals will only include files touched by tests', err);
      this._store.markScanComplete();
      this.emit('done');
      return;
    }
    if (scope.isDefault) {
      // No project rules to go by: generated output (reports, bundles) is usually git-ignored.
      const ignored = await gitIgnored(this._projectRoot, files);
      if (ignored.size > 0) {
        files = files.filter((fp) => !ignored.has(pathKey(fp)));
        log.debug(`Source scan: ${ignored.size} git-ignored file(s) left out`);
      }
    }
    log.debug(`Source scan: ${files.length} file(s) count toward coverage (${scope.source})`);

    const total = files.length;
    let scanned = 0;

    for (const filePath of files) {
      const counts = this._countFile(filePath);
      this._store.setCountedEntry(filePath, counts);
      this.emit('progress', ++scanned, total);

      if (scanned % YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    log.debug(`Source scan: ${scanned} file(s) counted in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    this._store.markScanComplete();
    this.emit('done');
  }

  private _countFile(filePath: string): {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  } {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { statements: 0, branches: 0, functions: 0, lines: 0 };
    }

    // The project's Babel, else the extension's own parser (Vitest projects have no Babel).
    const parser = loadBabelParser(this._projectRoot);
    if (!parser) {
      // Same message for every file → the logger collapses the repeats into one line.
      log.warn(`Could not load a Babel parser for ${this._projectRoot} — source files report 0 coverage totals`);
      return { statements: 0, branches: 0, functions: 0, lines: 0 };
    }
    const traverse = loadTraverse(this._projectRoot);

    let ast: any;
    try {
      ast = parser.parse(source, {
        sourceType: 'module',
        plugins: [
          'typescript', 'jsx', 'classProperties',
          'decorators-legacy', 'optionalChaining', 'nullishCoalescingOperator',
        ],
        errorRecovery: true,
      });
    } catch {
      return { statements: 0, branches: 0, functions: 0, lines: 0 };
    }

    let statements = 0;
    let branches   = 0;
    let functions  = 0;
    const executableLines = new Set<number>();

    try {
      traverse(ast, {
        // Statements (non-control-flow)
        ExpressionStatement(p: any)    { _countStmt(p.node, executableLines); statements++; },
        VariableDeclaration(p: any)    { _countStmt(p.node, executableLines); statements++; },
        ReturnStatement(p: any)        { _countStmt(p.node, executableLines); statements++; },
        ThrowStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        BreakStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        ContinueStatement(p: any)      { _countStmt(p.node, executableLines); statements++; },

        // Control-flow (count as a statement each)
        IfStatement(p: any)            { _countStmt(p.node, executableLines); statements++; branches += 2; },
        // Istanbul counts one branch slot per SwitchCase (not per SwitchStatement)
        SwitchCase(p: any)             { branches++; void p; },
        // Each `?.` is a 2-arm branch (non-null path vs short-circuit)
        OptionalMemberExpression(p: any) { if (p.node.optional) { branches += 2; } },
        OptionalCallExpression(p: any)   { if (p.node.optional) { branches += 2; } },
        ConditionalExpression(p: any)  { branches += 2; void p; },
        // Chained logical expressions (a || b || c) are one branch group with N leaves,
        // not N-1 groups of 2. Skip inner nodes of a same-operator chain.
        LogicalExpression(p: any) {
          if (p.parent?.type === 'LogicalExpression' &&
              p.parent.operator === p.node.operator &&
              p.parentKey === 'left') { return; }
          branches += _countLogicalLeaves(p.node);
        },
        ForStatement(p: any)           { _countStmt(p.node, executableLines); statements++; },
        ForInStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        ForOfStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        WhileStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        DoWhileStatement(p: any)       { _countStmt(p.node, executableLines); statements++; },
        // Istanbul counts the try block itself as a statement
        TryStatement(p: any)           { _countStmt(p.node, executableLines); statements++; },

        // Functions
        FunctionDeclaration(p: any)    { functions++; void p; },
        FunctionExpression(p: any)     { functions++; void p; },
        // Expression-body arrows: Istanbul counts the body as a statement
        ArrowFunctionExpression(p: any) {
          functions++;
          if (p.node.body?.type !== 'BlockStatement') {
            statements++;
            const line = p.node.body?.loc?.start?.line;
            if (line) { executableLines.add(line); }
          }
        },
        ClassMethod(p: any)            { functions++; void p; },
        ObjectMethod(p: any)           { functions++; void p; },
        // Default parameter values are tracked as single branch slots by Istanbul
        AssignmentPattern(p: any) {
          const pt = p.parent?.type;
          if (pt === 'FunctionDeclaration' || pt === 'FunctionExpression' ||
              pt === 'ArrowFunctionExpression' || pt === 'ClassMethod' || pt === 'ObjectMethod') {
            branches += 1;
          }
        },
      });
    } catch {
      // Partial parse — return what we have
    }

    return { statements, branches, functions, lines: executableLines.size };
  }
}

function _countStmt(node: any, lines: Set<number>): void {
  const line = node?.loc?.start?.line;
  if (line) { lines.add(line); }
}

function _countLogicalLeaves(node: any): number {
  if (node?.type !== 'LogicalExpression') { return 1; }
  return _countLogicalLeaves(node.left) + _countLogicalLeaves(node.right);
}

/** The files git ignores (as {@link pathKey}s); empty when git is missing or this is not a repo. */
function gitIgnored(cwd: string, files: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (files.length === 0) { resolve(new Set()); return; }
    let out = '';
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd, windowsHide: true });
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.on('error', () => resolve(new Set()));
    child.on('close', (code) => {
      // 0: some files ignored, 1: none, 128: not a repo / git error.
      if (code !== 0) { resolve(new Set()); return; }
      resolve(new Set(out.split('\0').filter(Boolean).map((rel) => pathKey(path.resolve(cwd, rel)))));
    });
    child.stdin.on('error', () => { /* git exited early — reported by 'close' */ });
    child.stdin.end(files.map((f) => path.relative(cwd, f)).join('\0') + '\0');
  });
}

function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
