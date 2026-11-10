import * as fs from 'fs';
import * as path from 'path';

/**
 * An Angular workspace (`angular.json`) and the projects in it whose `test`
 * target runs Vitest through Angular's unit-test builder
 * (`@angular/build:unit-test`, the default for new apps since Angular 21).
 * Karma projects (`runner: "karma"`, `@angular-devkit/build-angular:karma`)
 * are listed apart: they are not supported.
 */
export interface AngularProject {
  /** The name `ng test <name>` takes. */
  name: string;
  /** Absolute folder of the project (`root`; the workspace root for `""`). */
  root: string;
  /** Absolute source folder (`sourceRoot`, default `<root>/src`). */
  sourceRoot: string;
}

export interface AngularWorkspace {
  /** The folder with angular.json — where `ng` runs. */
  root: string;
  /** Projects tested with Vitest through the builder. */
  projects: AngularProject[];
  /** Names of projects tested with Karma (not supported). */
  karma: string[];
}

export const ANGULAR_UNIT_TEST_BUILDERS = ['@angular/build:unit-test', '@angular-devkit/build-angular:unit-test'];
const KARMA_BUILDERS = ['@angular-devkit/build-angular:karma', '@angular/build:karma'];

interface RawTarget { builder?: string; options?: { runner?: string } }
interface RawProject { root?: string; sourceRoot?: string; architect?: Record<string, RawTarget>; targets?: Record<string, RawTarget> }

/** The workspace whose angular.json is in `dir` (not searched upwards), or undefined. */
export function readAngularWorkspace(dir: string): AngularWorkspace | undefined {
  let raw: { projects?: Record<string, RawProject> };
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'angular.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const projects: AngularProject[] = [];
  const karma: string[] = [];
  for (const [name, p] of Object.entries(raw.projects ?? {})) {
    const test = (p.architect ?? p.targets ?? {}).test;
    if (!test?.builder) { continue; }
    const root = path.resolve(dir, p.root ?? '');
    const sourceRoot = path.resolve(dir, p.sourceRoot ?? path.join(p.root ?? '', 'src'));
    if (KARMA_BUILDERS.includes(test.builder) || (ANGULAR_UNIT_TEST_BUILDERS.includes(test.builder) && test.options?.runner === 'karma')) {
      karma.push(name);
    } else if (ANGULAR_UNIT_TEST_BUILDERS.includes(test.builder)) {
      projects.push({ name, root, sourceRoot });
    }
  }
  return { root: dir, projects, karma };
}

/** The project a file belongs to: the deepest source folder (else project folder) that contains it. */
export function angularProjectOf(workspace: AngularWorkspace, file: string): AngularProject | undefined {
  const inside = (f: string, dir: string) => { const r = path.relative(dir, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
  const bySource = workspace.projects.filter((p) => inside(file, p.sourceRoot)).sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0];
  return bySource ?? workspace.projects.filter((p) => inside(file, p.root)).sort((a, b) => b.root.length - a.root.length)[0];
}
