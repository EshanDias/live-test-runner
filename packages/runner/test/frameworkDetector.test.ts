import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrameworkDetector } from '../src/framework/FrameworkDetector';

function project(pkg: object, files: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr detect '));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const f of files) { fs.writeFileSync(path.join(dir, f), ''); }
  return dir;
}

describe('FrameworkDetector', () => {
  const dirs: string[] = [];
  const detect = (pkg: object, files?: string[]) => {
    const dir = project(pkg, files);
    dirs.push(dir);
    return new FrameworkDetector().detectFramework(dir);
  };
  afterAll(() => { for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); } });

  it('picks Vitest for a Vitest-only project', () => {
    expect(detect({ devDependencies: { vitest: '1' } })).toBe('vite');
  });

  it('picks Jest when a project has Vitest and a Jest config (e.g. jest-dom)', () => {
    expect(detect({ devDependencies: { vitest: '1', 'kcd-scripts': '1' } }, ['jest.config.js'])).toBe('jest');
  });

  it('picks Jest when a project has Vitest and Jest dependencies', () => {
    expect(detect({ devDependencies: { vitest: '1', jest: '29' } })).toBe('jest');
  });

  it('recognises jest.config.json and .mts configs', () => {
    expect(detect({}, ['jest.config.json'])).toBe('jest');
    expect(detect({ devDependencies: { vitest: '1' } }, ['jest.config.mts'])).toBe('jest');
  });

  it('picks CRA for react-scripts projects', () => {
    expect(detect({ dependencies: { 'react-scripts': '5' } })).toBe('cra');
  });
});
