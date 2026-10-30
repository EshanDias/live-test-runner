import * as path from 'path';
import { envName, pythonEnvChip } from '../src/python/pythonEnvChip';

const venvPy = path.join('/work', 'shop', '.venv', 'bin', 'python');
const info = (over: object = {}) => ({ python: venvPy, executable: venvPy, version: '3.12.4', venv: true, pytest: '9.1.1', coverage: '7.17.0', ...over });

describe('python environment chip', () => {
  it('names the environment: the venv folder (bin/ or Scripts/), conda-style folders, else system', () => {
    expect(envName(info())).toBe('.venv');
    expect(envName(info({ executable: path.join('C:', 'proj', 'venv', 'Scripts', 'python.exe') }))).toBe('venv');
    expect(envName(info({ executable: path.join('/home', 'me', '.cache', 'pypoetry', 'virtualenvs', 'shop-Ab12-py3.12', 'bin', 'python') }))).toBe('shop-Ab12-py3.12');
    expect(envName(info({ executable: path.join('C:', 'conda', 'envs', 'ml', 'python.exe') }))).toBe('ml');
    expect(envName(info({ venv: false, executable: '/usr/bin/python3' }))).toBe('system');
  });

  it('ready: version · environment · pytest; the tooltip has the path, the source and coverage', () => {
    const chip = pythonEnvChip({ state: 'ready', info: info(), source: '.venv' });
    expect(chip).toMatchObject({ text: 'Python 3.12.4 · .venv · pytest 9.1.1', warn: false });
    expect(chip.tooltip).toContain(venvPy);
    expect(chip.tooltip).toContain('Found via: .venv');
    expect(chip.tooltip).toContain('coverage 7.17.0');
    expect(pythonEnvChip({ state: 'ready', info: info({ coverage: undefined }), source: 'PATH' }).tooltip).toContain('no coverage');
  });

  it('unusable: a short reason, amber, the full reason in the tooltip', () => {
    const noPytest = pythonEnvChip({ state: 'unusable', info: info({ pytest: undefined }), source: '.venv', reason: 'pytest is not installed in this environment' });
    expect(noPytest).toMatchObject({ text: 'pytest not installed · .venv', warn: true });
    expect(noPytest.tooltip).toContain('pytest is not installed in this environment');
    expect(pythonEnvChip({ state: 'unusable', info: info({ version: '3.9.6' }), reason: 'Python 3.9.6 is older than the supported 3.12' }).text)
      .toBe('Python 3.9.6 · needs 3.12+');
    expect(pythonEnvChip({ state: 'unusable', info: info({ pytest: '6.2.5' }), reason: 'pytest 6.2.5 is older than the supported 7' }).text)
      .toBe('pytest 6.2.5 · needs 7+ · .venv');
    expect(pythonEnvChip({ state: 'unusable', reason: 'no Python interpreter was found' })).toMatchObject({ text: 'No Python found', warn: true });
  });

  it('not resolved yet: detecting', () => {
    expect(pythonEnvChip(undefined)).toMatchObject({ text: 'Python: detecting…', warn: false });
  });
});
