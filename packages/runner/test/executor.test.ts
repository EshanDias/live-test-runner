import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Executor } from '../src/execution/Executor';

/** A script that prints its argv as JSON (or sleeps / spawns a child, by flag). */
function writeScript(dir: string): string {
  const file = path.join(dir, 'echo-args.js');
  fs.writeFileSync(file, `
    const args = process.argv.slice(2);
    if (args[0] === '--sleep') {
      if (args[1] === '--with-child') {
        require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      }
      setTimeout(() => {}, 60000);
    } else {
      process.stdout.write(JSON.stringify(args));
    }
  `);
  return file;
}

describe('Executor', () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    // A folder with spaces, like "C:\Users\John Smith\…" (BUG-03).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr exec test '));
    script = writeScript(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes arguments to a JS entry point verbatim — no shell (BUG-03)', async () => {
    const args = [
      '--testNamePattern', '^(?:Math utils a\\^b \\| c & d)$',
      'C:/Users/John Smith/project/a.test.js',
      'a|b', 'x^y', '"quoted"', '100%', '',
    ];
    const r = await new Executor().run({ binary: script, args, cwd: dir });
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  it('runs from a working directory with spaces', async () => {
    const r = await new Executor().run({ binary: script, args: ['ok'], cwd: dir });
    expect(r.passed).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual(['ok']);
  });

  it('kill() ends the process and its children (BUG-08)', async () => {
    const ex = new Executor();
    const started = Date.now();
    const p = ex.run({ binary: script, args: ['--sleep', '--with-child'], cwd: dir });
    await new Promise((r) => setTimeout(r, 500));
    ex.kill();
    const r = await p;
    expect(r.passed).toBe(false);
    // The pipes close only when the child (and grandchild) are gone.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('stops a run that exceeds timeoutMs (hanging test, BUG-23)', async () => {
    const started = Date.now();
    const r = await new Executor().run({ binary: script, args: ['--sleep'], cwd: dir, timeoutMs: 800 });
    expect(r.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('reports a missing working directory without spawning', async () => {
    const r = await new Executor().run({ binary: script, args: [], cwd: path.join(dir, 'nope') });
    expect(r.passed).toBe(false);
    expect(r.stderr).toMatch(/does not exist/);
  });
});

describe('Executor — npx', () => {
  // buildInvocation is private; the decision is what matters here.
  const invocation = (args: string[]) =>
    (new Executor() as unknown as { buildInvocation(b: string, a: string[]): { args: string[] } }).buildInvocation('npx', args).args;

  it('adds "jest" for the Jest fallback, which passes only flags', () => {
    expect(invocation(['--watchAll=false'])).toEqual(['jest', '--watchAll=false']);
  });

  it('leaves a command that names its package alone ("npx vitest", "npx jest")', () => {
    expect(invocation(['vitest', 'run'])).toEqual(['vitest', 'run']);
    expect(invocation(['jest', '--ci'])).toEqual(['jest', '--ci']);
  });
});
