import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AngularRunner } from '../src/AngularRunner';
import { Executor, ExecutorCommand } from '../src/execution/Executor';
import { FrameworkDetector } from '../src/framework/FrameworkDetector';
import { readAngularWorkspace, angularProjectOf } from '../src/framework/angularWorkspace';
import { projectFrameworks } from '../src/framework/frameworkRouting';
import { findTestProjects } from '../src/framework/projectDiscovery';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';

/** The commands AngularRunner hands to the Executor, for an app + library workspace. */

let root: string;
let calls: ExecutorCommand[];

function pkg(dir: string, name: string, json: Record<string, unknown>, files: Record<string, string> = {}) {
  const d = path.join(root, 'node_modules', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, ...json }));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
}

beforeEach(() => {
  _resetProjectRoots();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-ng-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'ng test' }, devDependencies: { '@angular/cli': '^22', '@angular/build': '^22', vitest: '^5' } }));
  fs.writeFileSync(path.join(root, 'angular.json'), JSON.stringify({
    projects: {
      shop: { root: '', sourceRoot: 'src', architect: { test: { builder: '@angular/build:unit-test' } } },
      ui: { root: 'projects/ui', sourceRoot: 'projects/ui/src', architect: { test: { builder: '@angular/build:unit-test' } } },
      legacy: { root: 'projects/legacy', architect: { test: { builder: '@angular-devkit/build-angular:karma' } } },
    },
  }));
  pkg(root, '@angular/cli', { bin: { ng: './bin/ng.js' } }, { 'bin/ng.js': '' });
  pkg(root, 'vitest', { version: '5.1.0', bin: { vitest: './vitest.mjs' } }, { 'vitest.mjs': '' });
  calls = [];
  jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: '', stderr: '', jsonOutput: '{"testResults":[]}' };
  });
  jest.spyOn(Executor.prototype, 'run').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: 'Discovered test files:\n  src/app/app.spec.ts\n  projects/ui/src/lib/ui.spec.ts\n', stderr: '' };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const args = (c: ExecutorCommand) => c.args.map((a) => a.split(root).join('<root>').replace(/<root>.*ltr-ng-runner(-update)?\.config\.mjs$/, 'CONFIG$1').replace(/^.*ltr-vitest-reporter\.mjs$/, 'OUR-REPORTER').replace(/^.*ltr-result-.*\.json$/, 'RESULT'));

describe('angular.json', () => {
  it('lists the projects tested with Vitest through the builder; Karma apart', () => {
    const ws = readAngularWorkspace(root)!;
    expect(ws.projects.map((p) => [p.name, path.relative(root, p.sourceRoot)])).toEqual([['shop', 'src'], ['ui', path.join('projects', 'ui', 'src')]]);
    expect(ws.karma).toEqual(['legacy']);
    expect(angularProjectOf(ws, path.join(root, 'projects', 'ui', 'src', 'lib', 'ui.spec.ts'))?.name).toBe('ui');
    expect(angularProjectOf(ws, path.join(root, 'src', 'app', 'app.spec.ts'))?.name).toBe('shop');
  });

  it('stays Jest when the builder is in angular.json but Jest runs the tests (jest-preset-angular)', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'jest --no-cache' }, devDependencies: { jest: '^30', 'jest-preset-angular': '^17', '@angular/build': '^22' } }));
    expect(new FrameworkDetector().detect(root).framework).toBe('jest');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'jest' }, devDependencies: { jest: '^30', vitest: '^5' } }));
    expect(new FrameworkDetector().detect(root).framework).not.toBe('angular');
  });

  it('is detected as Angular (not plain Vitest), one project for the workspace', () => {
    expect(new FrameworkDetector().detect(root).framework).toBe('angular');
    expect(projectFrameworks(root, 'angular')).toMatchObject({ primary: 'angular', frameworks: ['angular'] });
    expect(findTestProjects([root]).map((p) => [p.name, p.framework])).toEqual([['shop', 'angular']]);
  });
});

describe('AngularRunner command lines', () => {
  it('lists every project, runs one project per command, filters by name, updates snapshots through its config', async () => {
    const runner = new AngularRunner('', () => {}, path.join(root, '.session'));
    const list = await runner.listTestFiles(root);
    expect(list.files).toEqual([path.join(root, 'src', 'app', 'app.spec.ts'), path.join(root, 'projects', 'ui', 'src', 'lib', 'ui.spec.ts')]);
    expect(list.groups).toEqual({ [list.files[0]]: 'shop', [list.files[1]]: 'ui' });
    await runner.runTestFilesJson([path.join(root, 'projects', 'ui', 'src', 'lib', 'ui.spec.ts')]);
    await runner.runTestCaseJson(path.join(root, 'src', 'app', 'app.spec.ts'), 'App renders', false, true);
    expect(calls.map(args)).toEqual([
      ['test', '--list-tests'],
      ['test', 'ui', '--include', 'projects/ui/src/lib/ui.spec.ts', '--watch=false', '--reporters', 'default', '--reporters', 'OUR-REPORTER', '--reporters', 'json', '--runner-config', 'CONFIG'],
      ['test', 'shop', '--include', 'src/app/app.spec.ts', '--filter', '^ ?(?:App(?: > | )renders)$', '--watch=false', '--reporters', 'default', '--reporters', 'OUR-REPORTER', '--reporters', 'json', '--runner-config', 'CONFIG-update'],
    ]);
    expect(path.basename(calls[1].binary)).toBe('ng.js');
    // Angular's build cache stays out of the project.
    expect(calls[1].extraEnv?.CI).toBe('true');
    const update = fs.readFileSync(fs.readdirSync(path.join(root, '.session')).map((f) => path.join(root, '.session', f)).find((f) => f.endsWith('-update.config.mjs'))!, 'utf8');
    expect(update).toContain('update: true');
    expect(update).toContain('includeTaskLocation: true');
  });
});
