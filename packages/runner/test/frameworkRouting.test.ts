import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  projectFrameworks,
  frameworkHint,
  globToRegExp,
  parseFrameworkRules,
  matchFrameworkRule,
  assignFrameworks,
  allowFrameworkAt,
  isFrameworkAllowedAt,
} from '../src/framework/frameworkRouting';
import { FrameworkDetector } from '../src/framework/FrameworkDetector';
import { JestRunner } from '../src/JestRunner';
import { VitestRunner } from '../src/VitestRunner';
import { FRAMEWORK_IDS } from '../src/types';

function tree(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr routing '));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('framework routing', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string | object>) => { const d = tree(files); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); } });

  describe('projectFrameworks', () => {
    it('a Jest root with its own vitest.config is mixed, Jest primary', () => {
      const root = make({ 'package.json': { devDependencies: { jest: '29', vitest: '3' } }, 'vitest.config.ts': 'export default {}' });
      const pf = projectFrameworks(root, new FrameworkDetector().detectFramework(root));
      expect(pf).toMatchObject({ primary: 'jest', mixed: true });
      expect(pf.reason).toContain('vitest.config.ts');
    });

    it('a vitest dependency alone (jest-dom) or a vite.config is not mixed', () => {
      const dep = make({ 'package.json': { devDependencies: { jest: '29', vitest: '3' } } });
      expect(projectFrameworks(dep, FRAMEWORK_IDS.jest).mixed).toBe(false);
      const vite = make({ 'package.json': { devDependencies: { jest: '29' } }, 'vite.config.ts': 'export default {}' });
      expect(projectFrameworks(vite, FRAMEWORK_IDS.jest).mixed).toBe(false);
    });

    it('a Vitest project is never mixed by detection', () => {
      const root = make({ 'package.json': { devDependencies: { vitest: '3' } }, 'vitest.config.ts': '' });
      expect(projectFrameworks(root, FRAMEWORK_IDS.vitest)).toMatchObject({ primary: 'vitest', mixed: false });
    });

    it('jest.config + vitest.workspace is mixed', () => {
      const root = make({ 'package.json': {}, 'jest.config.js': 'module.exports = {}', 'vitest.workspace.ts': '' });
      expect(projectFrameworks(root, FRAMEWORK_IDS.jest).mixed).toBe(true);
    });
  });

  describe('frameworkHint', () => {
    it.each([
      [`import { describe, it, vi } from 'vitest'`, 'vitest'],
      [`import { expect } from "@jest/globals"`, 'jest'],
      [`const { vi } = require('vitest')`, 'vitest'],
      [`const m = vi.fn()`, 'vitest'],
      [`jest.mock('./x')`, 'jest'],
      [`import 'vitest/globals'`, 'vitest'],
      [`it('works', () => expect(1).toBe(1))`, undefined],
      [`// jest.fn() mentioned in a comment\nit('x', () => {})`, undefined],
      [`/* vi.fn() */ it('x', () => {})`, undefined],
      [`jest.fn(); vi.fn();`, undefined],
      [`import { vi } from 'vitest'; jest.fn()`, 'vitest'],
      [`const obj = { jest: 1 }; obj.jest.x; myvi.fn()`, undefined],
    ])('%s → %s', (src, want) => {
      expect(frameworkHint(src)).toBe(want);
    });
  });

  describe('globs and the setting', () => {
    it('globToRegExp: **, *, ?, {a,b}, [..], name-only globs', () => {
      expect(globToRegExp('src/**/*.vitest.ts').test('src/a/b/x.vitest.ts')).toBe(true);
      expect(globToRegExp('src/**/*.vitest.ts').test('src/x.vitest.ts')).toBe(true);
      expect(globToRegExp('src/*.ts').test('src/a/x.ts')).toBe(false);
      expect(globToRegExp('*.spec.{ts,js}').test('deep/dir/a.spec.js')).toBe(true);
      expect(globToRegExp('file?.ts').test('file1.ts')).toBe(true);
      expect(globToRegExp('[ab].ts').test('a.ts')).toBe(true);
      expect(globToRegExp('[ab].ts').test('c.ts')).toBe(false);
    });

    it('parses entries relative to the workspace folder; first match wins', () => {
      const base = path.resolve('/ws');
      const { rules, errors } = parseFrameworkRules({
        'packages/new/**': 'vitest',
        '**/*.test.ts': { framework: 'Jest' },
      }, base);
      expect(errors).toEqual([]);
      expect(rules.map((r) => r.framework)).toEqual(['vitest', 'jest']);
      expect(matchFrameworkRule(rules, path.join(base, 'packages/new/a.test.ts'))?.framework).toBe('vitest');
      expect(matchFrameworkRule(rules, path.join(base, 'packages/old/a.test.ts'))?.framework).toBe('jest');
      expect(matchFrameworkRule(rules, path.resolve('/elsewhere/packages/new/a.test.ts'))).toBeUndefined();
    });

    it('reports invalid entries and unsupported keys', () => {
      const { rules, errors } = parseFrameworkRules({
        'a/**': 'mocha',
        'b/**': { framework: 'vitest', config: 'vitest.b.ts' },
      }, path.resolve('/ws'));
      expect(rules.map((r) => r.glob)).toEqual(['b/**']);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('"jest" or "vitest"');
      expect(errors[1]).toContain('"config" not supported');
      expect(parseFrameworkRules(['x'], '/ws').errors).toHaveLength(1);
      expect(parseFrameworkRules(undefined, '/ws')).toEqual({ rules: [], errors: [] });
    });
  });

  describe('assignFrameworks', () => {
    const key = (f: string) => f;
    const groups = (jest: string[] | undefined, vitest: string[] | undefined) => [
      { id: 'jest', framework: 'jest' as const, files: jest },
      { id: 'vitest', framework: 'vitest' as const, files: vitest },
    ];

    it('one group: every file is the project\'s (rule 2)', () => {
      const out = assignFrameworks({
        files: ['a', 'b'], keyOf: key, primary: 'jest',
        groups: [{ id: 'jest', framework: 'jest', files: ['a'] }],
      });
      expect(out.assignments.get('a')).toEqual({ group: 'jest', rule: 'project', runnable: true });
      expect(out.assignments.get('b')).toEqual({ group: 'jest', rule: 'project', runnable: false });
    });

    it('ownership, hints, the primary default and the setting', () => {
      const out = assignFrameworks({
        files: ['onlyJest', 'onlyVitest', 'bothHintV', 'bothNoHint', 'neither', 'forced'],
        keyOf: key,
        primary: 'jest',
        groups: groups(['onlyJest', 'bothHintV', 'bothNoHint', 'forced'], ['onlyVitest', 'bothHintV', 'bothNoHint', 'forced']),
        ruleFor: (f) => (f === 'forced' ? 'vitest' : undefined),
        hint: (f) => (f === 'bothHintV' ? 'vitest' : undefined),
      });
      const a = (f: string) => out.assignments.get(f);
      expect(a('onlyJest')).toEqual({ group: 'jest', rule: 'ownership', runnable: true });
      expect(a('onlyVitest')).toEqual({ group: 'vitest', rule: 'ownership', runnable: true });
      expect(a('bothHintV')).toEqual({ group: 'vitest', rule: 'hint', runnable: true });
      expect(a('bothNoHint')).toEqual({ group: 'jest', rule: 'primary', runnable: true });
      expect(a('neither')).toEqual({ group: 'jest', rule: 'ownership', runnable: false });
      expect(a('forced')).toEqual({ group: 'vitest', rule: 'setting', runnable: true });
      expect(out.defaulted).toEqual(['bothNoHint']);
      expect(out.hinted).toEqual(['bothHintV']);
    });

    it('a failed listing (undefined) may own any file', () => {
      const out = assignFrameworks({
        files: ['x', 'y'], keyOf: key, primary: 'jest',
        groups: groups(undefined, ['y']),
        hint: () => undefined,
      });
      expect(out.assignments.get('x')).toEqual({ group: 'jest', rule: 'ownership', runnable: true });
      // Listed by Vitest, maybe by Jest (its list failed), nothing in the file: Vitest's list decides.
      expect(out.assignments.get('y')).toEqual({ group: 'vitest', rule: 'ownership', runnable: true });
      expect(out.defaulted).toEqual([]);
    });

    it('a setting rule onto a group that does not list the file is not runnable', () => {
      const out = assignFrameworks({
        files: ['z'], keyOf: key, primary: 'jest',
        groups: groups(['z'], []),
        ruleFor: () => 'vitest',
      });
      expect(out.assignments.get('z')).toEqual({ group: 'vitest', rule: 'setting', runnable: false });
    });
  });

  describe('runners in a mixed root', () => {
    // Exposes the adapter the runner picked for its root (a refusing one throws on resolveConfig).
    class VitestProbe extends VitestRunner {
      config(root: string) { this.setProjectRoot(root); return this.requireAdapter().resolveConfig(root); }
    }
    class JestProbe extends JestRunner {
      framework(root: string) { this.setProjectRoot(root); return this.requireAdapter().framework; }
      config(root: string) { this.setProjectRoot(root); return this.requireAdapter().resolveConfig(root); }
    }

    it('Vitest refuses a Jest-detected root until the router allows it', async () => {
      const root = make({
        'package.json': { devDependencies: { jest: '29', vitest: '3' } },
        'vitest.config.ts': 'export default {}',
      });
      await expect(new VitestProbe().config(root)).rejects.toThrow();

      allowFrameworkAt(root, 'vitest');
      expect(isFrameworkAllowedAt(root, 'vitest')).toBe(true);
      expect(isFrameworkAllowedAt(root, 'jest')).toBe(false);
      expect(await new VitestProbe().config(root)).toBe(path.join(root, 'vitest.config.ts'));

      allowFrameworkAt(root, 'vitest', false);
      expect(isFrameworkAllowedAt(root, 'vitest')).toBe(false);
      await expect(new VitestProbe().config(root)).rejects.toThrow();
    });

    it('Jest runs in a Vitest root once allowed', async () => {
      const root = make({ 'package.json': { devDependencies: { vitest: '3' } }, 'vitest.config.ts': '' });
      await expect(new JestProbe().config(root)).rejects.toThrow();
      allowFrameworkAt(root, 'jest');
      expect(new JestProbe().framework(root)).toBe(FRAMEWORK_IDS.jest);
      await expect(new JestProbe().config(root)).resolves.toBeUndefined();
      allowFrameworkAt(root, 'jest', false);
    });
  });
});
