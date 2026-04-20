/**
 * SourceCounter — background scan at session start.
 *
 * AST-parses every source file in the workspace and counts statements,
 * branches, functions, and executable lines. Populates CoverageStore with
 * 'counted' entries (state = 0 hits) so untouched files are included in the
 * denominator, giving correct aggregate percentages.
 *
 * Mirrors TestDiscoveryService — fires and is forgotten, runs in parallel
 * with the first test run.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { CoverageStore } from './CoverageStore';

const YIELD_EVERY = 10;

export class SourceCounter extends EventEmitter {
  constructor(
    private readonly _projectRoot: string,
    private readonly _store: CoverageStore,
  ) {
    super();
  }

  async run(): Promise<void> {
    const include = new vscode.RelativePattern(this._projectRoot, '**/*.{js,ts,jsx,tsx}');
    // Flattened — no nested braces, VS Code glob doesn't support them reliably
    const defaultExcludeParts = [
      '**/node_modules/**',
      '**/*.test.js', '**/*.test.ts', '**/*.test.jsx', '**/*.test.tsx',
      '**/*.spec.js', '**/*.spec.ts', '**/*.spec.jsx', '**/*.spec.tsx',
      '**/__tests__/**', '**/__mocks__/**',
      '**/tests/**', '**/test/**', '**/specs/**', '**/spec/**',
      '**/*.config.js', '**/*.config.ts', '**/*.config.mjs', '**/*.config.cjs',
      '**/*.d.ts',
      'dist/**', 'build/**', 'out/**', '.next/**', 'coverage/**',
    ];
    const userExclude = vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<string[]>('coverageExclude', []);
    const allExcludeParts = userExclude.length > 0
      ? [...defaultExcludeParts, ...userExclude]
      : defaultExcludeParts;
    const excludeGlob = `{${allExcludeParts.join(',')}}`;

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(include, excludeGlob);
    } catch {
      this._store.markScanComplete();
      this.emit('done');
      return;
    }

    const total = uris.length;
    let scanned = 0;

    for (const uri of uris) {
      const counts = this._countFile(uri.fsPath);
      this._store.setCountedEntry(uri.fsPath, counts);
      this.emit('progress', ++scanned, total);

      if (scanned % YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

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

    // Lazy-load Babel from the project's node_modules
    let parser: any, traverse: any, t: any;
    try {
      const resolve = (id: string) =>
        require.resolve(id, { paths: [this._projectRoot, __dirname] });
      parser   = require(resolve('@babel/parser'));
      traverse = require(resolve('@babel/traverse'));
      t        = require(resolve('@babel/types'));
      if (traverse?.default) { traverse = traverse.default; }
      if (t?.default) { t = t.default; }
    } catch {
      return { statements: 0, branches: 0, functions: 0, lines: 0 };
    }

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
        SwitchCase(p: any)             { branches++; void p; },
        ConditionalExpression(p: any)  { branches += 2; void p; },
        LogicalExpression(p: any)      { branches += 2; void p; },
        ForStatement(p: any)           { _countStmt(p.node, executableLines); statements++; },
        ForInStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        ForOfStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        WhileStatement(p: any)         { _countStmt(p.node, executableLines); statements++; },
        DoWhileStatement(p: any)       { _countStmt(p.node, executableLines); statements++; },

        // Functions
        FunctionDeclaration(p: any)    { functions++; void p; },
        FunctionExpression(p: any)     { functions++; void p; },
        ArrowFunctionExpression(p: any){ functions++; void p; },
        ClassMethod(p: any)            { functions++; void p; },
        ObjectMethod(p: any)           { functions++; void p; },
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
