/**
 * TestFileDiscoverer — how one framework's test files are found and read
 * statically (before anything runs), so the Explorer and the editor show the
 * tests at once. The framework's own listing replaces the guess at Start.
 *
 * JS / TS frameworks share the Babel discoverer below; pytest has its own
 * line scanner (pythonDiscovery.ts). TestDiscoveryService only sees this
 * interface.
 */
import * as vscode from 'vscode';

export interface DiscoveredTest {
  name: string;
  /** 1-based. */
  line: number;
  /** Ancestor suites + name, space-joined. */
  fullName: string;
}

export interface DiscoveredSuite {
  name: string;
  /** 1-based. */
  line: number;
  tests: DiscoveredTest[];
  children: DiscoveredSuite[];
  isSharedVars: boolean;
  sharedVarNames: string[];
}

/** One file's static test tree; null when the file could not be parsed. */
export interface DiscoveredStructure {
  suites: DiscoveredSuite[];
  rootTests: DiscoveredTest[];
}

export interface TestFileDiscoverer {
  /** Globs (relative to the project root) of the files that may hold tests. */
  patterns(projectRoot: string): string[];
  /** One VS Code glob of folders never searched (dependencies, environments). */
  readonly exclude: string;
  /** A file the parser can read (a `*.test.*` glob also matches `.snap` files). */
  accepts(filePath: string): boolean;
  /** The file's tests, or null when it cannot be parsed (logged by the parser). */
  discover(source: string, filePath: string, projectRoot: string): DiscoveredStructure | null;
  /** "Jest tests" / "pytest tests" — for the discovery summary line. */
  readonly testsLabel: string;
}

/** Jest's default testMatch: *.test.* / *.spec.* files and anything in __tests__. */
export const DEFAULT_JS_TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**/*.*'];
/** Only JS/TS sources can be Jest / Vitest tests. */
const JS_TS_RE = /\.(c|m)?[jt]sx?$/i;

let babelDiscover: ((source: string, filePath: string, rootDir: string) => DiscoveredStructure | null) | undefined;
let babelLogger: { debug(m: string): void; warn(m: string): void; error(m: string): void } | undefined;

/** Where the Babel discoverer logs (set once by TestDiscoveryService). */
export function setJsDiscoveryLogger(log: { debug(m: string): void; warn(m: string): void; error(m: string): void }): void {
  babelLogger = log;
  if (babelDiscover) { loadBabelDiscovery(); }
}

function loadBabelDiscovery(): (source: string, filePath: string, rootDir: string) => DiscoveredStructure | null {
  // Loaded on first use: the module requires Babel, which a Python-only window never needs.
  const mod = require('../instrumentation/shared/testDiscovery.js') as {
    setLogger: (log: { debug(m: string): void; warn(m: string): void; error(m: string): void }) => void;
    discoverTests: (source: string, filePath: string, rootDir: string) => DiscoveredStructure | null;
  };
  if (babelLogger) { mod.setLogger(babelLogger); }
  babelDiscover = mod.discoverTests;
  return babelDiscover;
}

/** The liveTestRunner.testFilePatterns setting (BUG-17: it used to be ignored). */
function testFilePatterns(): string[] {
  const patterns = vscode.workspace
    .getConfiguration('liveTestRunner')
    .get<string[]>('testFilePatterns');
  return patterns && patterns.length > 0 ? patterns : DEFAULT_JS_TEST_PATTERNS;
}

/** Jest / Vitest: the testFilePatterns setting, parsed with Babel. */
export const jsDiscoverer: TestFileDiscoverer = {
  patterns: () => testFilePatterns(),
  exclude: '**/node_modules/**',
  accepts: (filePath) => JS_TS_RE.test(filePath),
  discover: (source, filePath, projectRoot) => (babelDiscover ?? loadBabelDiscovery())(source, filePath, projectRoot),
  testsLabel: 'Jest tests',
};
