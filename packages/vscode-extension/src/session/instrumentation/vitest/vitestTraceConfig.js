'use strict';
/**
 * vitestTraceConfig.js — loaded by the wrapper config Live Test Runner passes
 * to Vitest with `--config` (written by the runner's vitestTrace.ts into the
 * session folder). Runs in Vitest's main process while it loads its config.
 *
 *   wrapVitestConfig(env, options) → the project's own config (loaded with
 *   Vite's loadConfigFromFile from the project's own Vite) plus our Vite
 *   plugin, which adds the trace setup file and instruments source files.
 *
 * `test.projects` (Vitest ≥ 3.2): the plugin must reach every project.
 *   - inline projects get the plugin added (it is idempotent: a project that
 *     also inherits it from the root uses one copy), except on Vitest ≥ 5
 *     where an inline project that extends the declaring config inherits it
 *     anyway and adding it would cost it the shared Vite server;
 *   - config files and folders (`'packages/*'`) are replaced by one wrapper
 *     config each (`<dir>/vitest.config.mjs` in the session folder) that
 *     loads that config the same way and fixes `root` and `test.name` to what
 *     Vitest would have used for the original.
 * Workspaces (Vitest 3.x: a `vitest.workspace.*` / `vitest.projects.*` file
 * next to the config, or `test.workspace`): Vitest looks for the file next to
 * the config it was given — our wrapper, in the session folder — so it would
 * never find the project's. The wrapper loads the file (or takes the option)
 * and passes the same list inline as `test.workspace`, each entry wrapped as
 * for `test.projects`. Inline entries' `root` / `extends` are resolved against
 * the file's folder first, as Vitest does. Vitest 4+ has no workspaces.
 * Anything this cannot handle leaves the config untouched and reports why:
 * the run is then an ordinary one, without trace.
 *
 * The outcome is written to $LTR_VITEST_TRACE_MARKER (JSON) so the extension
 * knows whether the batch is traced, and why not.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createHash } = require('crypto');
const { ltrTracePlugin, PLUGIN_NAME } = require('./vitestTracePlugin.js');

const CONFIG_RE = /^vite(?:st)?(?:\.[\w-]+)?\.config\./;
const CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

const WORKSPACE_FILES = ['vitest.workspace', 'vitest.projects']
  .flatMap((n) => ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].map((e) => n + e));

function marker(result) {
  const file = process.env.LTR_VITEST_TRACE_MARKER;
  if (!file) { return; }
  try { fs.writeFileSync(file, JSON.stringify(result), 'utf8'); } catch (_) { /* diagnostics only */ }
}

/** "[LTR:<level>] msg" on stderr → the extension log (see the Jest transform). */
function ltrLog(level, msg) {
  const rank = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  if ((rank[level] ?? 2) < (rank[process.env.LTR_LOG_LEVEL] ?? 2)) { return; }
  process.stderr.write(`[LTR:${level}] vitest trace: ${String(msg).replace(/\s*\r?\n\s*/g, ' ↵ ')}\n`);
}

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
/** Comparison spelling: forward slashes, case-insensitive on Windows. */
const norm = (p) => { const n = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? n.toLowerCase() : n; };

/** What Vitest names a project defined by a config file or folder (its package name, else its folder). */
function defaultProjectName(dir) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name) { return name; }
  } catch (_) { /* no package.json */ }
  return path.basename(dir);
}

function isDynamicPattern(p) {
  return /[*?{}[\]()!]/.test(p);
}

async function globDirsAndFiles(patterns, cwd, options) {
  // tinyglobby is a Vitest dependency since 3.x; Node 22 has fs.glob.
  try {
    const req = require('module').createRequire(path.join(options.vitestDir, 'package.json'));
    const { glob } = req('tinyglobby');
    return await glob(patterns, {
      absolute: true, dot: true, onlyFiles: false, cwd, expandDirectories: false,
      ignore: ['**/node_modules/**', '**/*.timestamp-*', '**/.DS_Store'],
    });
  } catch (err) {
    if (typeof fs.globSync === 'function') {
      const out = [];
      for (const p of patterns) {
        for (const m of fs.globSync(p, { cwd, withFileTypes: false })) {
          if (/(^|[\\/])node_modules([\\/]|$)/.test(m)) { continue; }
          const abs = path.resolve(cwd, m);
          let dir = false;
          try { dir = fs.statSync(abs).isDirectory(); } catch (_) { /* gone */ }
          out.push(dir ? abs.replace(/[\\/]?$/, '/') : abs);
        }
      }
      return out;
    }
    throw err;
  }
}

/** Config files / folders a string project entry names (Vitest's own rules). */
async function resolveStringEntry(entry, root, options) {
  const s = entry.replace('<rootDir>', root);
  if (!isDynamicPattern(s)) {
    const file = path.resolve(root, s);
    if (!fs.existsSync(file)) { throw new Error(`project "${entry}" does not exist`); }
    return [fs.statSync(file).isDirectory() ? file.replace(/[\\/]?$/, '/') : file];
  }
  return globDirsAndFiles([s], root, options);
}

/** A config file or folder project → the config file to load (undefined: a folder without one). */
function projectConfigFile(entryPath) {
  if (!/[\\/]$/.test(entryPath)) {
    if (!CONFIG_RE.test(path.basename(entryPath))) { throw new Error(`"${entryPath}" is not a vitest.config / vite.config file`); }
    return entryPath;
  }
  const files = new Set(fs.readdirSync(entryPath));
  const name = CONFIG_NAMES.find((f) => files.has(f));
  return name ? path.join(entryPath, name) : undefined;
}

/**
 * One wrapper config per config-file / folder project, in the session
 * folder. Its file name must look like a Vitest config (Vitest checks).
 */
function writeProjectWrapper(options, target) {
  const id = createHash('sha1').update(target.configFile || target.root).digest('hex').slice(0, 12);
  const dir = path.join(options.wrapperDir, `project-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vitest.config.mjs');
  const projectOptions = { ...options, config: target.configFile || null, forceRoot: target.root, forceName: target.name, nested: true, selfFile: file };
  delete projectOptions.mode;
  fs.writeFileSync(file, wrapperSource(projectOptions), 'utf8');
  return file;
}

/** The source of a wrapper config (also written by the runner for the root). */
function wrapperSource(options) {
  return `// Live Test Runner: execution trace wrapper (generated — do not edit)
import { pathToFileURL } from 'node:url';
const options = ${JSON.stringify(options)};
export default async (env) => {
  const helper = await import(pathToFileURL(options.helper).href);
  return (helper.default || helper).wrapVitestConfig(env, options);
};
`;
}

/**
 * `test.projects` with our plugin reaching every project (see the header).
 * @returns the new list
 */
async function wrapProjects(projects, root, options, report, inlineDir = root) {
  const out = [];
  const rootConfig = options.config ? norm(options.config) : undefined;
  for (const def of projects) {
    if (typeof def === 'string') {
      const entries = await resolveStringEntry(def, root, options);
      for (const entryPath of entries) {
        const configFile = projectConfigFile(entryPath);
        // The root config itself: Vitest runs it as the root project — the wrapper is that config now.
        if (configFile && rootConfig && norm(configFile) === rootConfig && options.selfFile) {
          out.push(options.selfFile);
          report.projects++;
          continue;
        }
        const projectDir = /[\\/]$/.test(entryPath) ? entryPath.replace(/[\\/]$/, '') : path.dirname(entryPath);
        out.push(writeProjectWrapper(options, { configFile, root: projectDir, name: defaultProjectName(projectDir) }));
        report.projects++;
      }
      continue;
    }
    let p = typeof def === 'function' ? await def({ command: 'serve', mode: options.mode || 'test', isPreview: false, isSsrBuild: false }) : await def;
    if (!p || typeof p !== 'object') { out.push(def); continue; }
    report.projects++;
    if (inlineDir !== root) {
      // A workspace file's inline entries: `root` / `extends` are relative to the file's folder.
      p = { ...p };
      if (typeof p.root === 'string') { p.root = path.resolve(inlineDir, p.root); }
      if (typeof p.extends === 'string') { p.extends = path.resolve(inlineDir, p.extends); }
    }
    const ext = p.extends;
    const inherits = options.major >= 5
      ? ext === undefined || ext === true || (typeof ext === 'string' && path.resolve(root, ext) === options.selfFile)
      : ext === true;
    if (inherits && options.major >= 5) { out.push(p); continue; }
    out.push({ ...p, plugins: [...toArray(p.plugins), ltrTracePlugin(options)] });
  }
  return out;
}

/**
 * The project's Vitest 3 workspace: `{ definitions, dir }` (dir: where its
 * inline entries' paths are relative to), or undefined when it has none.
 * Same lookup as Vitest: `test.workspace` (a list, or a file path), else a
 * workspace file in the folder of the config (no config: the root).
 */
async function findWorkspace(test, root, env, options, vite) {
  if (Array.isArray(test.workspace)) { return { definitions: test.workspace, dir: root, source: '`test.workspace`' }; }
  let file;
  if (typeof test.workspace === 'string') {
    file = path.resolve(root, test.workspace);
  } else {
    const dir = options.config ? path.dirname(options.config) : root;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { /* none */ }
    const name = WORKSPACE_FILES.find((f) => names.includes(f));
    if (name) { file = path.join(dir, name); }
  }
  if (!file) { return undefined; }
  return { definitions: await loadWorkspaceFile(file, env, options, vite), dir: path.dirname(file), source: path.basename(file) };
}

/**
 * A workspace file's default export (a list). Loaded the way the project's
 * config is (the project's Vite bundles it: TS, `defineWorkspace` imports),
 * through a tiny loader in the session folder — Vite only accepts a config
 * that is an object.
 */
async function loadWorkspaceFile(file, env, options, vite) {
  if (/\.json$/i.test(file)) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  const id = createHash('sha1').update(file).digest('hex').slice(0, 12);
  const loader = path.join(options.wrapperDir, `workspace-${id}.config.mjs`);
  fs.mkdirSync(options.wrapperDir, { recursive: true });
  fs.writeFileSync(loader, `// Live Test Runner: loads ${path.basename(file)} (generated — do not edit)
import workspace from ${JSON.stringify(file.replace(/\\/g, '/'))};
export default { workspace };
`, 'utf8');
  const loaded = await vite.loadConfigFromFile(env, loader, options.projectRoot);
  const list = loaded && loaded.config && loaded.config.workspace;
  if (!Array.isArray(list)) { throw new Error(`${path.basename(file)} must export a default array of projects`); }
  return list;
}

/**
 * The project's config + our plugin.
 * @param env Vite's config env ({ command, mode, ... })
 * @param options from the generated wrapper: helper, vite (Vite's ESM entry), config (the
 *   project's config file or null), projectRoot, major, setupFile, parser, wrapperDir,
 *   vitestDir, selfFile; for project wrappers forceRoot / forceName
 */
async function wrapVitestConfig(env, options) {
  const report = { ok: false, projects: 0, reason: '' };
  // e2e only (vitest-trace): a wrapper that breaks the run, to check the fallback.
  if (process.env.LTR_E2E_BREAK_TRACE_WRAPPER && !options.nested) {
    throw new Error('LTR_E2E_BREAK_TRACE_WRAPPER is set');
  }
  const vite =await import(pathToFileURL(options.vite).href);
  let user = {};
  if (options.config) {
    // Errors loading the project's own config are the project's: Vitest would hit them too.
    const loaded = await vite.loadConfigFromFile(env, options.config, options.forceRoot || options.projectRoot);
    user = (loaded && loaded.config) || {};
  }
  try {
    const test = user.test || {};
    const root = options.forceRoot
      ? path.resolve(options.forceRoot, user.root || '.')
      : (user.root ? path.resolve(options.projectRoot, user.root) : options.projectRoot);
    // Options for plugins of inline projects (their root is their own business).
    const own = { ...options, mode: env && env.mode };
    delete own.forceRoot; delete own.forceName; delete own.nested;
    let out = { ...user, test: { ...test } };
    if (Array.isArray(test.projects)) {
      out.test.projects = await wrapProjects(test.projects, root, own, report);
    }
    // Workspaces exist on Vitest 3 only (4+ ignores them); a project config has none.
    const workspace = options.major === 3 && !options.nested && !Array.isArray(test.projects)
      ? await findWorkspace(test, root, env, options, vite) : undefined;
    if (workspace) {
      out.test.workspace = await wrapProjects(workspace.definitions, root, own, report, workspace.dir);
      ltrLog('debug', `Vitest workspace (${workspace.source}): ${report.projects} project(s) traced`);
    }
    if (options.forceRoot) {
      out.root = root;
      if (out.test.root) { out.test.root = path.resolve(root, out.test.root); }
      if (!out.test.name && options.forceName) { out.test.name = options.forceName; }
    }
    // A config-file / folder project: Vitest passes the wrapper's folder as
    // an inline `root` (which beats the config's); the plugin puts it back.
    out = vite.mergeConfig(out, { plugins: [ltrTracePlugin({ ...own, forceRoot: options.forceRoot ? root : undefined })] });
    report.ok = true;
    if (!options.nested) { marker(report); }
    return out;
  } catch (err) {
    report.reason = `could not add the trace to the config: ${err && err.message}`;
    ltrLog('warn', `${report.reason} — running without the execution trace`);
    if (!options.nested) { marker(report); }
    return user;
  }
}

module.exports = { wrapVitestConfig, wrapperSource, PLUGIN_NAME, _defaultProjectName: defaultProjectName };
