'use strict';
/**
 * vitestTracePlugin.js — the Vite plugin behind Vitest's execution trace.
 *
 *  - config: puts the trace setup file (vitestTraceSetup.mjs) FIRST in
 *    `test.setupFiles`, so its beforeEach opens a test's trace context before
 *    the project's own hooks run (as the Jest setup file does);
 *  - resolveId: `import … from 'vitest'` in that setup file resolves from the
 *    project root (the file itself lives in the extension);
 *  - transform (enforce 'post', after the project's own transforms):
 *    `__strace.step(line, file)` before every statement of the project's own
 *    source files, with the source's line numbers — not
 *    node_modules, not test files, not files outside the project. No list
 *    of extensions: JS / TS files, and any other module a Vite plugin
 *    compiled to JS (.vue, .svelte, .astro, .mdx, .coffee, …) whose combined
 *    source map leads back to the file itself — its own lines are recorded.
 *    Assets and data (`nonSourceExtensions`: CSS, JSON, images…) never are,
 *    and sub-modules (`Comp.vue?vue&type=style…`) have a query.
 *
 * Idempotent: a project may get the plugin twice (added to an inline project
 * that also inherits it); only the first copy in a resolved config works.
 * Browser-mode projects are left alone (their code runs in a browser).
 * Any error instrumenting a file leaves that file as it was.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { instrument } = require('./vitestTraceTransform.js');
const { mapsBackTo } = require('../shared/sourceMapLookup.js');

const PLUGIN_NAME = 'live-test-runner:trace';
const SCRIPT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
/** Never source, when the options name none (the extension passes its list: sourceFiles.ts NON_SOURCE_EXTENSIONS). */
const DEFAULT_NON_SOURCE = ['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss', 'sss', 'json', 'json5', 'jsonc',
  'html', 'htm', 'xml', 'svg', 'md', 'markdown', 'txt', 'csv', 'yaml', 'yml', 'toml', 'graphql', 'gql', 'glsl', 'wgsl', 'vert', 'frag',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm'];
const extOf = (file) => { const m = /\.([^./]+)$/.exec(file); return m ? m[1].toLowerCase() : ''; };
const TEST_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:[\\/]__tests__[\\/])/i;

// Vitest's main process also loads instrumented modules (globalSetup, config
// imports): there the calls must be no-ops.
if (typeof globalThis.__strace === 'undefined') {
  globalThis.__strace = { step() {} };
}

let _parser = null;
function loadParser(parserPath, projectRoot) {
  if (_parser) { return _parser; }
  try { _parser = require(require.resolve('@babel/parser', { paths: [projectRoot] })); } catch (_) { /* not in the project */ }
  if (!_parser) { _parser = require(parserPath); }
  return _parser;
}

function ltrLog(level, msg) {
  const rank = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  if ((rank[level] ?? 2) < (rank[process.env.LTR_LOG_LEVEL] ?? 2)) { return; }
  process.stderr.write(`[LTR:${level}] vitest trace: ${String(msg).replace(/\s*\r?\n\s*/g, ' ↵ ')}\n`);
}

/** Comparison spelling: forward slashes, case-insensitive on Windows. */
const norm = (p) => { const n = path.normalize(p).replace(/\\/g, '/'); return process.platform === 'win32' ? n.toLowerCase() : n; };
const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * @param {{ setupFile: string, parser: string, projectRoot: string, vite?: string, forceRoot?: string, nonSourceExtensions?: string[] }} options
 */
function ltrTracePlugin(options) {
  const setupFile = options.setupFile;
  // The root as given and as Vite spells module ids (symlinks resolved: macOS /var → /private/var).
  // Windows: 8.3 short names (C:\Users\RUNNER~1) vs the long ones Vitest runs from — the native realpath.
  let rootPrefixes = [];
  const addRoot = (r) => {
    if (!r) { return; }
    const all = [r];
    try { all.push(fs.realpathSync(r)); } catch (_) { /* as given */ }
    try { all.push(fs.realpathSync.native(r)); } catch (_) { /* as given */ }
    rootPrefixes = [...new Set([...rootPrefixes, ...all.map((x) => norm(x).replace(/\/?$/, '/'))])];
  };
  addRoot(options.projectRoot);
  let active = false;
  let root = options.projectRoot;
  let failures = 0;
  let viteServer = null;
  let depsWritten = false;
  const nonSource = new Set((options.nonSourceExtensions || DEFAULT_NON_SOURCE).map((e) => String(e).toLowerCase()));

  const plugin = {
    name: PLUGIN_NAME,
    // After the project's own transforms (TypeScript, JSX, Vue…): what runs is
    // plain JS, and nothing reformats it after us — the /*ltr*/ markers the
    // setup file's Function.prototype.toString removes stay intact. Lines are
    // mapped back to the source through the incoming source map.
    enforce: 'post',
    config: {
      order: 'pre',
      async handler(config) {
        if (options.forceRoot) { config.root = options.forceRoot; }
        // Browser mode runs tests in a browser: no setup file, no transform there.
        if (config.test && config.test.browser && config.test.browser.enabled) { return; }
        const test = config.test || (config.test = {});
        const others = toArray(test.setupFiles).filter((f) => typeof f !== 'string' || norm(f) !== norm(setupFile));
        test.setupFiles = [setupFile, ...others];
        // The setup file lives in the extension: Vite only serves files under
        // server.fs.allow (the workspace root by default) to web-mode
        // environments (jsdom, happy-dom). Setting the list replaces Vite's
        // default, so the workspace root goes in too.
        const server = config.server || (config.server = {});
        const fsOpts = server.fs || (server.fs = {});
        const setupDir = path.dirname(path.dirname(setupFile)); // instrumentation/ (setup + runtime)
        if (Array.isArray(fsOpts.allow)) {
          fsOpts.allow = [...fsOpts.allow, setupDir];
        } else if (options.vite) {
          try {
            const vite = await import(pathToFileURL(options.vite).href);
            const base = config.root ? path.resolve(options.projectRoot, config.root) : options.projectRoot;
            fsOpts.allow = [vite.searchForWorkspaceRoot(base), setupDir];
          } catch (err) {
            ltrLog('debug', `could not extend server.fs.allow: ${err && err.message}`);
          }
        }
      },
    },
    configureServer(server) {
      viteServer = server;
    },
    // Vitest closes its Vite server(s) at the end of a run: write which project
    // files import which (the module graph — imports, `?raw` / `?url` files,
    // files plugins read with addWatchFile, e.g. Angular templates), so a save
    // of any file a test loaded reruns exactly the test files that reach it.
    closeBundle() {
      if (!active || !viteServer || depsWritten || !process.env.LTR_VITEST_DEPS) { return; }
      depsWritten = true;
      try {
        const importers = {};
        const graphs = viteServer.environments
          ? Object.values(viteServer.environments).map((e) => e && e.moduleGraph).filter(Boolean)
          : [viteServer.moduleGraph];
        const own = (f) => !!f && !f.includes('/node_modules/') && rootPrefixes.some((r) => norm(f).startsWith(r));
        // Native spelling, as the trace records have it (Vite's ids use forward slashes on Windows too).
        const native = (f) => path.normalize(f);
        for (const graph of graphs) {
          for (const [file, mods] of graph.fileToModulesMap || []) {
            if (!own(file)) { continue; }
            const key = native(file);
            const set = new Set(importers[key] || []);
            for (const m of mods) {
              for (const i of m.importers || []) { if (i.file && i.file !== file && own(i.file)) { set.add(native(i.file)); } }
            }
            importers[key] = [...set];
          }
        }
        const out = `${process.env.LTR_VITEST_DEPS}.${process.pid}-${Math.random().toString(36).slice(2)}.json`;
        fs.writeFileSync(out, JSON.stringify({ importers }), 'utf8');
        ltrLog('debug', `module graph: ${Object.keys(importers).length} project file(s) → ${path.basename(out)}`);
      } catch (err) {
        ltrLog('debug', `could not write the module graph: ${err && err.message}`);
      }
    },
    configResolved(config) {
      root = config.root || root;
      addRoot(config.root);
      const first = (config.plugins || []).find((p) => p && p.name === PLUGIN_NAME);
      const browser = !!(config.test && config.test.browser && config.test.browser.enabled);
      active = first === plugin && !browser;
    },
    async resolveId(id, importer) {
      if (id !== 'vitest' || !importer || norm(importer.split('?')[0]) !== norm(setupFile)) { return null; }
      return this.resolve('vitest', path.join(root, 'package.json'), { skipSelf: true });
    },
    transform(code, id) {
      if (!active || typeof code !== 'string') { return null; }
      if (id.includes('?') || id.startsWith('\0')) { return null; }
      const file = norm(id);
      if (!rootPrefixes.some((r) => file.startsWith(r)) || file.includes('/node_modules/') || nonSource.has(extOf(file)) ||
          TEST_RE.test(file) || /\.d\.[cm]?ts$/.test(file)) {
        return null;
      }
      try {
        let inputMap;
        try { inputMap = this.getCombinedSourcemap(); } catch (_) { inputMap = undefined; }
        const compiled = !SCRIPT_RE.test(file);
        if (!inputMap && (compiled || (typeof this.originalCode === 'string' && this.originalCode !== code))) {
          return null; // transformed, but no way back to the source lines
        }
        // Compiled from another language: only when the map leads back to this very file.
        if (compiled && !mapsBackTo(inputMap, id)) { return null; }
        const out = instrument(code, path.normalize(id), loadParser(options.parser, options.projectRoot), inputMap);
        if (!out) { return null; }
        ltrLog('trace', `instrumented ${id} (${out.statements} statements)`);
        return { code: out.code, map: out.map };
      } catch (err) {
        if (failures++ < 20) { ltrLog('debug', `could not instrument ${id} — it runs without trace: ${err && err.message}`); }
        return null;
      }
    },
  };
  return plugin;
}

module.exports = { ltrTracePlugin, PLUGIN_NAME };
