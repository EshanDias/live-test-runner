/**
 * The Explorer's Python environment chip (pytest projects): which Python runs
 * the tests, at a glance — "Python 3.12.4 · .venv · pytest 9.1.1" — and,
 * when it can't, why ("pytest not installed · .venv"). Clicking the chip
 * opens Select Python Interpreter.
 */
import * as path from 'path';
import { MIN_PYTEST, MIN_PYTHON, PythonInfo } from '@live-test-runner/runner';
import type { PythonStatus } from './PythonInterpreters';

export interface PythonEnvChip {
  /** One line on the chip. */
  text: string;
  /** Hover text: full path, where it came from, the packages found. */
  tooltip: string;
  /** Amber: the tests can't run with it. */
  warn: boolean;
}

/**
 * The environment's name: a virtual environment's folder (`.venv`, a poetry
 * or conda env), else "system".
 */
export function envName(info: PythonInfo): string {
  if (!info.venv) { return 'system'; }
  const exe = info.executable || info.python;
  // <env>/bin/python · <env>\Scripts\python.exe · conda on Windows: <env>\python.exe
  const dir = path.dirname(exe);
  const base = path.basename(dir).toLowerCase();
  const envDir = base === 'bin' || base === 'scripts' ? path.dirname(dir) : dir;
  return path.basename(envDir) || 'venv';
}

const short = (v: string) => v.replace(/\.0(\.0)?$/, '');

export function pythonEnvChip(status: PythonStatus | undefined): PythonEnvChip {
  if (!status) {
    return { text: 'Python: detecting…', tooltip: 'Looking for the project\'s Python environment', warn: false };
  }
  const pick = 'Click to choose another environment';
  if (status.state === 'ready') {
    const info = status.info;
    return {
      text: `Python ${info.version} · ${envName(info)} · pytest ${info.pytest}`,
      tooltip: [
        info.executable || info.python,
        `Found via: ${status.source}`,
        `pytest ${info.pytest} · ${info.coverage ? `coverage ${info.coverage}` : 'no coverage (install "coverage" for coverage and covering tests)'}`,
        pick,
      ].join('\n'),
      warn: false,
    };
  }
  const info = status.info;
  let text: string;
  if (!info) {
    text = 'No Python found';
  } else if (status.reason.startsWith('Python ')) {
    text = `Python ${info.version} · needs ${short(MIN_PYTHON)}+`;
  } else if (!info.pytest) {
    text = `pytest not installed · ${envName(info)}`;
  } else {
    text = `pytest ${info.pytest} · needs ${short(MIN_PYTEST)}+ · ${envName(info)}`;
  }
  return {
    text,
    tooltip: [status.reason, ...(info ? [info.executable || info.python] : []), pick].join('\n'),
    warn: true,
  };
}
