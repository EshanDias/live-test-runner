import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  _resetVitestProjects, _setVitestProbe, rememberVitestConfigIn, sameConfigInfo, vitestConfigCachePath, vitestConfigInfo, VitestConfigInfo,
} from '../src/framework/vitestProjects';

/** The probe's answer, remembered between sessions (a new session = a cleared memory cache). */
describe('remembered Vitest config', () => {
  let root: string;
  let store: string;
  let config: string;
  let answers: (VitestConfigInfo | undefined)[];
  let probes: number;
  const info = (name: string): VitestConfigInfo => ({ projects: [{ name, browser: false }], coverageProvider: 'v8' });
  const newSession = () => _resetVitestProjects();
  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr vcfg '));
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr vcfg store '));
    config = path.join(root, 'vitest.config.js');
    fs.writeFileSync(config, 'export default {}\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    answers = [];
    probes = 0;
    _setVitestProbe(async () => { probes++; return answers.length > 1 ? answers.shift() : answers[0]; });
    rememberVitestConfigIn(store);
    newSession();
  });
  afterEach(() => {
    _setVitestProbe();
    rememberVitestConfigIn(undefined);
    newSession();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('answers the next session from disk, before its probe ends, and checks it in the background', async () => {
    answers = [info('a')];
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('a'));
    await settle();
    expect(fs.existsSync(vitestConfigCachePath(root, store))).toBe(true);

    newSession();
    let release!: () => void;
    _setVitestProbe(() => { probes++; return new Promise((r) => { release = () => r(info('a')); }); });
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('a')); // the probe has not ended
    expect(probes).toBe(2);
    release();
  });

  it('a different background answer replaces it for the rest of the session and the next', async () => {
    answers = [info('a')];
    await vitestConfigInfo(root, config, root);
    await settle();
    newSession();
    answers = [info('b')];
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('a'));
    await settle();
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('b'));
    newSession();
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('b'));
  });

  it('a changed config file is probed again and waited for', async () => {
    answers = [info('a')];
    await vitestConfigInfo(root, config, root);
    await settle();
    newSession();
    fs.writeFileSync(config, 'export default { test: {} }\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(config, later, later);
    answers = [info('c')];
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('c'));
  });

  it('a failed background probe keeps what worked; nothing is remembered from a failed first probe', async () => {
    answers = [info('a')];
    await vitestConfigInfo(root, config, root);
    await settle();
    newSession();
    answers = [undefined];
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('a'));
    await settle();
    expect(await vitestConfigInfo(root, config, root)).toEqual(info('a'));

    fs.rmSync(vitestConfigCachePath(root, store));
    newSession();
    expect(await vitestConfigInfo(root, config, root)).toBeUndefined();
    await settle();
    expect(fs.existsSync(vitestConfigCachePath(root, store))).toBe(false);
  });

  it('remembers nothing until a folder is named', async () => {
    rememberVitestConfigIn(undefined);
    answers = [info('a')];
    await vitestConfigInfo(root, config, root);
    await settle();
    expect(fs.readdirSync(store)).toEqual([]);
  });

  it('the coverage globs in another order are the same answer (vueuse lists them differently each time)', () => {
    const cov = (exclude: string[]): VitestConfigInfo => ({ ...info('a'), coverage: { root: '/r', include: ['src/**'], exclude } });
    expect(sameConfigInfo(cov(['a', 'b']), cov(['b', 'a']))).toBe(true);
    expect(sameConfigInfo(cov(['a', 'b']), cov(['a', 'c']))).toBe(false);
    expect(sameConfigInfo(info('a'), info('b'))).toBe(false);
  });
});
