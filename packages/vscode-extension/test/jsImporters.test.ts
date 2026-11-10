import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { relativeSpecifiers, resolveRelative, testFilesImporting } from '../src/session/jsImporters';

let root: string;
const w = (rel: string, text: string) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const isTest = (f: string) => /\.spec\.ts$/.test(f);

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-imp-')));
  w('src/app/cart.ts', 'export class Cart {}\n');
  w('src/app/app.ts', "import { Component } from '@angular/core';\nimport { Cart } from './cart';\n");
  w('src/app/cart.spec.ts', "import { Cart } from './cart';\n");
  w('src/app/app.spec.ts', "import { App } from './app';\n");
  w('src/app/util/index.ts', 'export const x = 1;\n');
  w('src/app/util.spec.ts', "const u = await import('./util');\n");
  w('src/app/alias.ts', 'export const y = 2;\n');
  w('src/app/other.spec.ts', "import { y } from '@app/alias';\n");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('jsImporters', () => {
  it('reads relative specifiers of every import form, and resolves them as TypeScript does', () => {
    expect(relativeSpecifiers("import a from './a';\nexport * from '../b';\nimport type { T } from './t';\nconst c = require('./c');\nimport('./d');\nimport 'lib';")).toEqual(['./a', '../b', './t', './c', './d']);
    expect(resolveRelative(path.join(root, 'src/app/app.ts'), './cart')).toBe(path.join(root, 'src/app/cart.ts'));
    expect(resolveRelative(path.join(root, 'src/app/app.ts'), './cart.js')).toBe(path.join(root, 'src/app/cart.ts'));
    expect(resolveRelative(path.join(root, 'src/app/app.ts'), './util')).toBe(path.join(root, 'src/app/util/index.ts'));
  });

  it('finds the tests importing a file directly or through other files', () => {
    expect(testFilesImporting(path.join(root, 'src/app/cart.ts'), [path.join(root, 'src')], isTest)?.sort())
      .toEqual([path.join(root, 'src/app/app.spec.ts'), path.join(root, 'src/app/cart.spec.ts')]);
    expect(testFilesImporting(path.join(root, 'src/app/util/index.ts'), [path.join(root, 'src')], isTest)).toEqual([path.join(root, 'src/app/util.spec.ts')]);
  });

  it('a test file is its own answer; a file imported only through an alias cannot be told (undefined: run everything)', () => {
    expect(testFilesImporting(path.join(root, 'src/app/cart.spec.ts'), [path.join(root, 'src')], isTest)).toEqual([path.join(root, 'src/app/cart.spec.ts')]);
    expect(testFilesImporting(path.join(root, 'src/app/alias.ts'), [path.join(root, 'src')], isTest)).toBeUndefined();
  });
});
