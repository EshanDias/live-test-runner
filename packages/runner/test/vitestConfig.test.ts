import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testScriptVitestArgs } from '../src/framework/vitestConfig';

describe('testScriptVitestArgs', () => {
  const dirs: string[] = [];
  const project = (scripts: Record<string, string>, files: string[] = []) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr vscript ')));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
    for (const f of files) { fs.writeFileSync(path.join(dir, f), ''); }
    return dir;
  };
  afterAll(() => { for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); } });

  it('reads flags after a direct vitest call, ignoring subcommands and filters', () => {
    expect(testScriptVitestArgs(project({ test: 'vitest run --globals --environment jsdom src' })).args)
      .toEqual(['--globals', '--environment=jsdom']);
    expect(testScriptVitestArgs(project({ test: 'vitest test' })).args).toEqual([]); // slidev: "test" is a filter
  });

  it('follows nr / npm run / pnpm / yarn into other scripts, with their extra args (vueuse)', () => {
    const vueuse = { test: 'nr test:unit --project=server', 'test:unit': 'vitest --project unit' };
    expect(testScriptVitestArgs(project(vueuse)).args).toEqual(['--project=unit', '--project=server']);
    expect(testScriptVitestArgs(project({ test: 'npm run unit -- --project a', unit: 'vitest' })).args).toEqual(['--project=a']);
    expect(testScriptVitestArgs(project({ test: 'pnpm unit', unit: 'cross-env CI=1 vitest --dir src' })).args).toEqual(['--dir=src']);
    expect(testScriptVitestArgs(project({ test: 'yarn run unit', unit: 'vitest -r packages/x' })).args).toEqual(['--root=packages/x']);
  });

  it('finds vitest after other commands (unplugin: "nr test:build && vitest run")', () => {
    expect(testScriptVitestArgs(project({ test: 'nr test:build && vitest run --mode test', 'test:build': 'node build.js' })).args)
      .toEqual(['--mode=test']);
  });

  it('keeps quoted project names whole', () => {
    expect(testScriptVitestArgs(project({ test: 'vitest --project="browser (chromium)"' })).args)
      .toEqual(['--project=browser (chromium)']);
  });

  it('returns --config separately, only when the file exists', () => {
    const dir = project({ test: 'vitest -c vitest.unit.ts' }, ['vitest.unit.ts']);
    expect(testScriptVitestArgs(dir)).toEqual({ config: path.join(dir, 'vitest.unit.ts'), args: [] });
    expect(testScriptVitestArgs(project({ test: 'vitest --config missing.ts' }))).toEqual({ args: [] });
  });

  it('ignores scripts that are not test runs, or never call vitest', () => {
    expect(testScriptVitestArgs(project({ test: 'vitest bench --project a' })).args).toEqual([]);
    expect(testScriptVitestArgs(project({ test: 'jest --ci' })).args).toEqual([]);
    expect(testScriptVitestArgs(project({ test: 'npm test' })).args).toEqual([]); // self-reference stops
  });
});
