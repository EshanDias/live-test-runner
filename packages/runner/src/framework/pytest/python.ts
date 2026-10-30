/**
 * The Python interpreter a pytest project runs with, and what is installed
 * in it.
 *
 * The extension decides the interpreter (the user's choice, the project's
 * virtual environment, the Python extension's, PATH — pytest plan D7), probes
 * it once and registers it here per project root; the runner only reads it.
 * Nothing is installed or changed in the environment (CLAUDE.md rule 9).
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { compareVersions, parseVersion } from '../../utils/semver';

/** What the probe found in one interpreter. Versions are undefined when the package is missing. */
export interface PythonInfo {
  /** Absolute path of the interpreter. */
  python: string;
  /** `3.12.4`. */
  version: string;
  /** The interpreter's own `sys.executable` (a venv's python, not its base). */
  executable: string;
  /** In a virtual environment (`sys.prefix != sys.base_prefix`). */
  venv: boolean;
  pytest?: string;
  coverage?: string;
  xdist?: string;
  pytestCov?: string;
  debugpy?: string;
}

/** Oldest supported versions (pytest plan D2). */
export const MIN_PYTHON = '3.12.0';
export const MIN_PYTEST = '7.0.0';

const PROBE = [
  'import json, sys',
  'from importlib import metadata',
  'def v(name):',
  '    try:',
  '        return metadata.version(name)',
  '    except Exception:',
  '        return None',
  'print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable,',
  '  "venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),',
  '  "pytest": v("pytest"), "coverage": v("coverage"), "xdist": v("pytest-xdist"),',
  '  "pytestCov": v("pytest-cov"), "debugpy": v("debugpy")}))',
].join('\n');

/**
 * Runs the interpreter once (isolated mode: nothing from the project is
 * imported) and reads what is installed. Rejects when it does not start or
 * does not answer within `timeoutMs`.
 */
export function probePython(python: string, cwd: string, timeoutMs = 15_000): Promise<PythonInfo> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(python, ['-I', '-c', PROBE], { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const timer = setTimeout(() => {
      if (done) { return; }
      done = true;
      try { child.kill(); } catch { /* gone */ }
      reject(new Error(`${python} did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out += d; });
    child.stderr?.on('data', (d: string) => { err += d; });
    child.on('error', (e) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (code !== 0 || !line) {
        reject(new Error(`${python} exited with code ${code}${err.trim() ? `: ${err.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}`));
        return;
      }
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const str = (k: string) => (typeof raw[k] === 'string' ? raw[k] as string : undefined);
        resolve({
          python,
          version: str('version') ?? '0',
          executable: str('executable') ?? python,
          venv: raw.venv === true,
          pytest: str('pytest'),
          coverage: str('coverage'),
          xdist: str('xdist'),
          pytestCov: str('pytestCov'),
          debugpy: str('debugpy'),
        });
      } catch (e) {
        reject(new Error(`${python} printed an unreadable answer: ${(e as Error).message}`));
      }
    });
  });
}

/** Why the interpreter cannot run the project's tests, or undefined when it can. */
export function unsupportedReason(info: PythonInfo): string | undefined {
  const older = (v: string, min: string) => {
    const a = parseVersion(v);
    return !a || compareVersions(a, parseVersion(min)!) < 0;
  };
  if (older(info.version, MIN_PYTHON)) {
    return `Python ${info.version} is older than the supported ${MIN_PYTHON.replace(/\.0$/, '')}`;
  }
  if (!info.pytest) {
    return `pytest is not installed in this environment (install it in the project's environment, e.g. "pip install pytest")`;
  }
  if (older(info.pytest, MIN_PYTEST)) {
    return `pytest ${info.pytest} is older than the supported ${MIN_PYTEST.replace(/\.0\.0$/, '')}`;
  }
  return undefined;
}

/** "Python 3.12.4 · pytest 9.1.1 · coverage 7.17.0" */
export function describePython(info: PythonInfo): string {
  return [
    `Python ${info.version}`,
    info.pytest ? `pytest ${info.pytest}` : 'no pytest',
    info.coverage ? `coverage ${info.coverage}` : 'no coverage',
    ...(info.xdist ? [`xdist ${info.xdist}`] : []),
    ...(info.pytestCov ? [`pytest-cov ${info.pytestCov}`] : []),
  ].join(' · ');
}

// ── Registry: the interpreter of each project root ───────────────────────────

const byRoot = new Map<string, PythonInfo>();

function key(root: string): string {
  const r = path.resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** The extension's choice for a project root (undefined clears it). */
export function setPythonFor(root: string, info: PythonInfo | undefined): void {
  if (info) { byRoot.set(key(root), info); } else { byRoot.delete(key(root)); }
}

/** The interpreter registered for a project root. */
export function pythonFor(root: string): PythonInfo | undefined {
  return byRoot.get(key(root));
}
