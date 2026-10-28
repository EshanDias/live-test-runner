/**
 * PythonInterpreters — which Python runs a pytest project (pytest plan D7).
 *
 * Order, first usable one wins:
 *  1. the user's choice — the "Select Python Interpreter" command, remembered
 *     per project in the extension's own storage (never written to the
 *     project or its `.vscode/settings.json`, CLAUDE.md rule 9);
 *  2. the `liveTestRunner.pythonPath` setting;
 *  3. a virtual environment in the project (`.venv`, `venv`, `env` — uv,
 *     `python -m venv`, pip, in-project poetry), then the workspace folder;
 *     then the tool's own answer when its lock file is there (`poetry env
 *     info -p`, `pipenv --venv`), and uv's `UV_PROJECT_ENVIRONMENT`;
 *  4. the Python extension's interpreter for the folder (when installed);
 *  5. an activated environment (`VIRTUAL_ENV` / `CONDA_PREFIX`) inside the project;
 *  6. `python3` / `python` on PATH (`py -3` on Windows).
 *
 * No activation is needed: the environment's own `python` is run directly.
 * Each candidate is probed once (version, pytest, coverage, xdist,
 * pytest-cov, debugpy); one with pytest wins over one without. The choice
 * is registered with the runner (setPythonFor) and logged on every Start.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PythonInfo, describePython, probePython, setPythonFor, unsupportedReason } from '@live-test-runner/runner';
import { logger } from '../utils/logger';

const log = logger.scope('Python');

const IS_WIN = process.platform === 'win32';
const VENV_DIRS = ['.venv', 'venv', 'env'];
const STATE_KEY = 'liveTestRunner.pythonInterpreter';

/** Where a candidate interpreter came from — shown with it ("`.venv` (uv)"). */
export interface Candidate {
  python: string;
  source: string;
}

/** The interpreter chosen for a project. */
export interface ChosenPython {
  info: PythonInfo;
  source: string;
}

/** The python executable inside a virtual environment folder. */
export function venvPython(dir: string): string {
  return IS_WIN ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

function exists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function inside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Runs a tool and returns its trimmed stdout (undefined on any failure). Spawned, never exec (rule 2). */
function toolOutput(command: string, args: string[], cwd: string, timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (v: string | undefined) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      // Windows: poetry / pipenv are often .cmd shims — run through the shell as one command line (DEP0190).
      child = IS_WIN
        ? spawn([command, ...args].join(' '), { cwd, windowsHide: true, shell: true })
        : spawn(command, args, { cwd, windowsHide: true });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(undefined); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(undefined); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : undefined); });
  });
}

/** The Python extension's interpreter for a folder (undefined when it is not installed or has none). */
async function pythonExtensionInterpreter(folder: vscode.Uri): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (!ext) { return undefined; }
  try {
    const api = (ext.isActive ? ext.exports : await ext.activate()) as {
      environments?: {
        getActiveEnvironmentPath(resource?: vscode.Uri): { path: string } | undefined;
        resolveEnvironment(env: { path: string } | string): Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
      };
    } | undefined;
    const envs = api?.environments;
    const active = envs?.getActiveEnvironmentPath(folder);
    if (!envs || !active?.path) { return undefined; }
    const resolved = await envs.resolveEnvironment(active);
    return resolved?.executable?.uri?.fsPath ?? active.path;
  } catch (err) {
    log.debug(`The Python extension did not report an interpreter: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Every candidate for a project, in the order above (duplicates removed).
 * `chosen` and `setting` are the user's own picks.
 */
export async function findCandidates(projectRoot: string, opts: {
  chosen?: string;
  setting?: string;
  workspaceFolder?: string;
  env?: NodeJS.ProcessEnv;
  pythonExtension?: () => Promise<string | undefined>;
  tool?: typeof toolOutput;
}): Promise<Candidate[]> {
  const env = opts.env ?? process.env;
  const tool = opts.tool ?? toolOutput;
  const out: Candidate[] = [];
  const add = (python: string | undefined, source: string) => {
    if (!python) { return; }
    const key = IS_WIN ? python.toLowerCase() : python;
    if (!out.some((c) => (IS_WIN ? c.python.toLowerCase() : c.python) === key)) { out.push({ python, source }); }
  };

  if (opts.chosen) { add(opts.chosen, 'selected'); }
  if (opts.setting) {
    const base = opts.workspaceFolder ?? projectRoot;
    const s = opts.setting.replace(/\$\{workspaceFolder\}/g, base);
    add(path.isAbsolute(s) ? s : path.resolve(base, s), 'liveTestRunner.pythonPath');
  }

  const roots = [projectRoot, ...(opts.workspaceFolder && opts.workspaceFolder !== projectRoot ? [opts.workspaceFolder] : [])];
  for (const r of roots) {
    for (const dir of VENV_DIRS) {
      const py = venvPython(path.join(r, dir));
      if (exists(py)) { add(py, r === projectRoot ? dir : `${dir} (workspace folder)`); }
    }
  }
  if (env.UV_PROJECT_ENVIRONMENT) {
    const dir = path.resolve(projectRoot, env.UV_PROJECT_ENVIRONMENT);
    if (exists(venvPython(dir))) { add(venvPython(dir), 'UV_PROJECT_ENVIRONMENT'); }
  }
  if (exists(path.join(projectRoot, 'poetry.lock'))) {
    const dir = await tool('poetry', ['env', 'info', '-p'], projectRoot);
    if (dir && exists(venvPython(dir))) { add(venvPython(dir), 'poetry'); }
  }
  if (exists(path.join(projectRoot, 'Pipfile.lock')) || exists(path.join(projectRoot, 'Pipfile'))) {
    const dir = await tool('pipenv', ['--venv'], projectRoot);
    if (dir && exists(venvPython(dir))) { add(venvPython(dir), 'pipenv'); }
  }
  if (opts.pythonExtension) { add(await opts.pythonExtension(), 'Python extension'); }
  for (const [name, source] of [['VIRTUAL_ENV', 'activated environment'], ['CONDA_PREFIX', 'conda environment']] as const) {
    const dir = env[name];
    if (!dir) { continue; }
    const py = name === 'CONDA_PREFIX' && IS_WIN ? path.join(dir, 'python.exe') : venvPython(dir);
    if (exists(py) && roots.some((r) => inside(py, r))) { add(py, source); }
  }
  if (IS_WIN) {
    add('py', 'py launcher');
    add('python', 'PATH');
  } else {
    add('python3', 'PATH');
    add('python', 'PATH');
  }
  return out;
}

export class PythonInterpreters {
  private readonly _chosen = new Map<string, Promise<ChosenPython>>();
  /** Roots already told that no interpreter works — once per root until it changes. */
  private readonly _told = new Set<string>();

  constructor(private readonly _state?: vscode.Memento) {}

  /**
   * The project's interpreter, probed and registered with the runner.
   * @throws an Error explaining what is missing (shown once as a notification)
   */
  ensure(projectRoot: string): Promise<ChosenPython> {
    let p = this._chosen.get(projectRoot);
    if (!p) {
      p = this._resolve(projectRoot);
      this._chosen.set(projectRoot, p);
      p.catch(() => this._chosen.delete(projectRoot));
    }
    return p;
  }

  /** The interpreter already chosen for a project (undefined until {@link ensure} finished). */
  async peek(projectRoot: string): Promise<ChosenPython | undefined> {
    const p = this._chosen.get(projectRoot);
    return p ? p.catch(() => undefined) : undefined;
  }

  /** Forget the choice of one project (or all): the next run resolves again. */
  invalidate(projectRoot?: string): void {
    for (const root of projectRoot ? [projectRoot] : [...this._chosen.keys()]) {
      this._chosen.delete(root);
      this._told.delete(root);
      setPythonFor(root, undefined);
    }
  }

  /** "Select Python Interpreter": every environment found + Browse…, remembered per project. */
  async select(projectRoot: string): Promise<boolean> {
    const candidates = await findCandidates(projectRoot, this._options(projectRoot, false));
    type Item = vscode.QuickPickItem & { python?: string; browse?: boolean; clear?: boolean };
    const items: Item[] = [];
    const current = (await this.peek(projectRoot))?.info.python;
    for (const c of candidates) {
      try {
        const info = await probePython(c.python, projectRoot);
        const bad = unsupportedReason(info);
        const detail = bad ? `⚠ ${bad}` : describePython(info);
        items.push({ label: `${c.python === current ? '$(check) ' : ''}${info.executable}`, description: c.source, detail, python: info.executable });
      } catch {
        /* not runnable — not offered */
      }
    }
    items.push({ label: '$(folder-opened) Browse…', description: 'choose a python executable', browse: true });
    if (this._state?.get<Record<string, string>>(STATE_KEY)?.[projectRoot]) {
      items.push({ label: '$(discard) Use automatic detection', description: 'forget the selected interpreter', clear: true });
    }
    const pick = await vscode.window.showQuickPick(items, { title: `Python interpreter for ${path.basename(projectRoot)}`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) { return false; }
    let python = pick.python;
    if (pick.browse) {
      const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri: vscode.Uri.file(projectRoot), title: 'Select a Python interpreter' });
      if (!uri?.[0]) { return false; }
      python = uri[0].fsPath;
    }
    const all = { ...(this._state?.get<Record<string, string>>(STATE_KEY) ?? {}) };
    if (pick.clear) { delete all[projectRoot]; } else if (python) { all[projectRoot] = python; }
    await this._state?.update(STATE_KEY, all);
    this.invalidate(projectRoot);
    log.info(pick.clear
      ? `${path.basename(projectRoot)}: Python interpreter back to automatic detection`
      : `${path.basename(projectRoot)}: Python interpreter set to ${python}`);
    return true;
  }

  private _options(projectRoot: string, withExtension: boolean): Parameters<typeof findCandidates>[1] {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot));
    const setting = vscode.workspace.getConfiguration('liveTestRunner', folder?.uri).get<string>('pythonPath')?.trim();
    return {
      chosen: this._state?.get<Record<string, string>>(STATE_KEY)?.[projectRoot],
      setting: setting || undefined,
      workspaceFolder: folder?.uri.fsPath,
      pythonExtension: withExtension && folder ? () => pythonExtensionInterpreter(folder.uri) : undefined,
    };
  }

  private async _resolve(projectRoot: string): Promise<ChosenPython> {
    const candidates = await findCandidates(projectRoot, this._options(projectRoot, true));
    let fallback: ChosenPython | undefined;
    const tried: string[] = [];
    for (const c of candidates) {
      let info: PythonInfo;
      try {
        info = await probePython(c.python, projectRoot);
      } catch (err) {
        tried.push(`${c.python} (${c.source}): ${(err as Error).message}`);
        // The user's own choice must work — never silently fall through to another Python.
        if (c.source === 'selected' || c.source === 'liveTestRunner.pythonPath') { break; }
        continue;
      }
      // A name on PATH: register the real executable it runs.
      if (!path.isAbsolute(info.python)) { info = { ...info, python: info.executable }; }
      const bad = unsupportedReason(info);
      if (!bad) {
        setPythonFor(projectRoot, info);
        log.info(`${path.basename(projectRoot)}: ${describePython(info)} — ${info.python} (${c.source})`);
        return { info, source: c.source };
      }
      tried.push(`${info.python} (${c.source}): ${bad}`);
      fallback ??= { info, source: c.source };
      if (c.source === 'selected' || c.source === 'liveTestRunner.pythonPath') { break; }
    }
    const reason = fallback ? unsupportedReason(fallback.info)! : 'no Python interpreter was found';
    const message = `No Python environment that can run pytest was found for ${path.basename(projectRoot)}: ${reason}.`;
    log.warn(`${message} Tried:\n${tried.map((t) => `  ${t}`).join('\n') || '  (nothing)'}`);
    this._tellOnce(projectRoot, message);
    throw new Error(message);
  }

  private _tellOnce(projectRoot: string, message: string): void {
    if (this._told.has(projectRoot)) { return; }
    this._told.add(projectRoot);
    void vscode.window.showWarningMessage(`${message} Select the project's environment (its .venv, poetry or conda env).`, 'Select Interpreter').then((choice) => {
      if (choice) { void vscode.commands.executeCommand('liveTestRunner.selectPythonInterpreter', projectRoot); }
    });
  }
}

let _instance: PythonInterpreters | undefined;

/** The window's interpreter registry (set up in activate with the workspace storage). */
export function pythonInterpreters(): PythonInterpreters {
  return (_instance ??= new PythonInterpreters());
}

export function initPythonInterpreters(state: vscode.Memento): PythonInterpreters {
  _instance = new PythonInterpreters(state);
  return _instance;
}
