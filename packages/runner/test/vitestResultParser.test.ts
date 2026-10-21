import * as fs from 'fs';
import * as path from 'path';
import {
  parseVitestResult,
  VITEST_FILE_FAILURE,
  VITEST_HOOK_FAILURE,
  VITEST_UNHANDLED_ERROR,
} from '../src/parsing/VitestResultParser';
import { RunResult } from '../src/types';
import { setLogSink } from '../src/utils/logger';

/**
 * Real `vitest run --reporter=json` reports of the same four files, one per
 * major version (test/fixtures/vitest, paths replaced by /project):
 *   t/probe.test.js  nested suites, pass / fail / todo / skip / test.each, a top-level test
 *   t/hook.test.js   beforeAll throws
 *   t/broken.test.js imports a missing module
 *   t/empty.test.js  no tests
 * 1.x and 2.x ran without --includeTaskLocation (the CLI flag arrived in 3.0).
 */
const VERSIONS = ['1.6.1', '2.1.9', '3.2.4', '4.1.11', '5.0.5'];
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'vitest', `${name}.json`), 'utf8');
const file = (r: RunResult, rel: string) => r.fileResults.find((f) => f.testFilePath === `/project/t/${rel}`)!;

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(undefined));

describe.each(VERSIONS)('Vitest %s json report', (version) => {
  const r = parseVitestResult(false, fixture(`v${version}`), '');
  const modern = Number(version.split('.')[0]) >= 3;

  it('reads every file', () => {
    expect(r.fileResults.map((f) => path.basename(f.testFilePath)).sort())
      .toEqual(['broken.test.js', 'empty.test.js', 'hook.test.js', 'probe.test.js']);
  });

  it('maps each test: names, ancestors, status', () => {
    expect(file(r, 'probe.test.js').testCases.map((c) => [c.fullName, c.ancestorTitles, c.title, c.status])).toEqual([
      ['Outer Inner adds', ['Outer', 'Inner'], 'adds', 'passed'],
      ['Outer Inner fails', ['Outer', 'Inner'], 'fails', 'failed'],
      ['Outer adds too', ['Outer'], 'adds too', 'passed'],
      ['Outer later', ['Outer'], 'later', 'todo'],
      ['Outer skipped', ['Outer'], 'skipped', 'skipped'],
      ['Outer each 1', ['Outer'], 'each 1', 'passed'],
      ['Outer each 2', ['Outer'], 'each 2', 'failed'],
      ['top level', [], 'top level', 'passed'],
    ]);
    expect(file(r, 'probe.test.js').status).toBe('failed');
  });

  it('counts from the tests, like Jest (todo is not pending)', () => {
    expect([r.numPassedTests, r.numFailedTests, r.numPendingTests]).toEqual([4, 2, 3]);
  });

  it('keeps the assertion message without the stack, integer durations', () => {
    const fails = file(r, 'probe.test.js').testCases.find((c) => c.title === 'fails')!;
    expect(fails.failureMessages).toHaveLength(1);
    expect(fails.failureMessages[0]).toMatch(/expected \{ a: 1 \} to deeply equal \{ a: 2 \}/);
    expect(fails.failureMessages[0]).not.toMatch(/\n\s+at /);
    for (const c of file(r, 'probe.test.js').testCases) {
      if (c.duration !== undefined) { expect(Number.isInteger(c.duration)).toBe(true); }
    }
    expect(file(r, 'probe.test.js').duration).toBe(100);
  });

  it('has test lines with --includeTaskLocation, and never an assertion position', () => {
    const lines = file(r, 'probe.test.js').testCases.map((c) => c.location?.line);
    expect(lines).toEqual(modern ? [4, 5, 7, 8, 9, 10, 10, 12] : Array(8).fill(undefined));
  });

  it('gives a file that cannot load its reason', () => {
    const broken = file(r, 'broken.test.js');
    expect(broken.status).toBe('failed');
    expect(broken.testCases).toEqual([]);
    expect(broken.failureMessage).toMatch(/does-not-exist\.js/);
    expect(file(r, 'empty.test.js').failureMessage).toMatch(/No test suite found/);
  });

  it('explains a failing beforeAll, whose error the report leaves out', () => {
    const hook = file(r, 'hook.test.js');
    expect(hook.status).toBe('failed');
    expect(hook.failureMessage).toBe(VITEST_HOOK_FAILURE);
    expect(hook.testCases.map((c) => c.status)).toEqual(version.startsWith('1.') ? ['pending', 'pending'] : ['skipped', 'skipped']);
  });
});

describe('parseVitestResult — run level', () => {
  it('explains an exit code 1 with every test passing (unhandled error)', () => {
    const r = parseVitestResult(false, fixture('v5.0.5-unhandled'), '');
    expect(r.fileResults[0].status).toBe('passed');
    expect(r.errors).toEqual([VITEST_UNHANDLED_ERROR]);
  });

  it("prefers Vitest's stderr when there is some", () => {
    expect(parseVitestResult(false, fixture('v5.0.5-unhandled'), 'Error: boom\n').errors).toEqual(['Error: boom']);
  });

  it('has no errors for a passing run', () => {
    expect(parseVitestResult(true, fixture('v5.0.5-unhandled'), '').errors).toEqual([]);
  });

  it('turns no / bad output into a failed result', () => {
    expect(parseVitestResult(false, '', 'config error')).toMatchObject({ passed: false, fileResults: [], errors: ['config error'] });
    expect(parseVitestResult(false, '{', '').errors).toEqual(['{']);
  });

  it('explains a failed file with no tests and no message', () => {
    const raw = JSON.stringify({ testResults: [{ name: '/p/a.test.ts', status: 'failed', message: '', assertionResults: [] }] });
    expect(parseVitestResult(false, raw, '').fileResults[0].failureMessage).toBe(VITEST_FILE_FAILURE);
  });

  it('merges a file run by several projects: a failure anywhere wins', () => {
    const run = (status: string) => ({
      name: '/p/a.test.ts', status: status === 'failed' ? 'failed' : 'passed',
      assertionResults: [{ ancestorTitles: [], title: 't', fullName: 't', status, failureMessages: status === 'failed' ? ['boom'] : [] }],
    });
    const r = parseVitestResult(false, JSON.stringify({ testResults: [run('passed'), run('failed')] }), '');
    expect(r.fileResults).toHaveLength(1);
    expect(r.fileResults[0].testCases[0]).toMatchObject({ status: 'failed', failureMessages: ['boom'] });
  });

  it('strips colour codes and maps unknown statuses to skipped', () => {
    const raw = JSON.stringify({ testResults: [{
      name: '/p/a.test.ts', status: 'failed', message: '\u001b[31mbad\u001b[39m',
      assertionResults: [{ ancestorTitles: [], title: 'x', status: 'disabled', failureMessages: ['\u001b[31mred\u001b[39m'] }],
    }] });
    const f = parseVitestResult(false, raw, '').fileResults[0];
    expect(f.failureMessage).toBe('bad');
    expect(f.testCases[0]).toMatchObject({ status: 'skipped', failureMessages: ['red'] });
  });
});
