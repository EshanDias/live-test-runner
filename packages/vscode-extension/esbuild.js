const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const watch  = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** Copy all instrumentation .js files to out/instrumentation/ after each build.
 *
 * These files run inside Jest worker processes (not the extension host), so they
 * cannot be bundled by esbuild — they must exist as separate files on disk at
 * the exact path specified in the Jest config injected by the runners.
 *
 * Files from timeline/instrumentation → timeline debugger (traceTransform/traceRuntime)
 * Files from session/instrumentation  → session-wide tracing, kept in shared/ (trace
 *   runtime, framework-neutral), jest/ (transform, reporter, setup file) and
 *   vitest/ (wrapper-config helper, Vite plugin, transform, setup file)
 */
function copyInstrumentationFiles() {
  const dest = path.join(__dirname, 'out', 'instrumentation');
  fs.mkdirSync(dest, { recursive: true });

  const timelineSrc = path.join(__dirname, 'src', 'timeline', 'instrumentation');
  for (const file of ['traceTransform.js', 'traceRuntime.js']) {
    fs.copyFileSync(path.join(timelineSrc, file), path.join(dest, file));
  }

  // Session instrumentation keeps its layout (shared/ + one folder per
  // framework): files find each other by relative path at runtime.
  const sessionSrc = path.join(__dirname, 'src', 'session', 'instrumentation');
  const sessionFiles = {
    shared: ['sessionTraceRuntime.js'],
    jest: ['sessionTraceTransform.js', 'liveReporter.js', 'ltrCoverageSetup.js'],
    vitest: ['vitestTraceConfig.js', 'vitestTracePlugin.js', 'vitestTraceTransform.js', 'vitestTraceSetup.mjs'],
  };
  for (const [dir, files] of Object.entries(sessionFiles)) {
    fs.mkdirSync(path.join(dest, dir), { recursive: true });
    for (const file of files) {
      fs.copyFileSync(path.join(sessionSrc, dir, file), path.join(dest, dir, file));
    }
  }
}

/**
 * Ships @babel/parser (one self-contained file, MIT) in out/vendor/: static
 * test discovery uses the project's own Babel when it has one (every Jest
 * project does), and this copy otherwise — Vitest projects usually have no
 * Babel. The published .vsix has no node_modules (vsce --no-dependencies).
 */
function copyVendorFiles() {
  const dest = path.join(__dirname, 'out', 'vendor');
  fs.mkdirSync(dest, { recursive: true });
  const pkgDir = path.dirname(require.resolve('@babel/parser/package.json'));
  fs.copyFileSync(path.join(pkgDir, 'lib', 'index.js'), path.join(dest, 'babel-parser.js'));
  fs.copyFileSync(path.join(pkgDir, 'LICENSE'), path.join(dest, 'babel-parser.LICENSE'));
}

/** The user guide (docs/live-test-runner-guide.html) for the Open Guide command. */
function copyGuide() {
  const dest = path.join(__dirname, 'out', 'guide');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'docs', 'live-test-runner-guide.html'), path.join(dest, 'guide.html'));
}

const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: minify ? false : true,
  minify,
};

if (watch) {
  const onRebuild = {
    name: 'copy-instrumentation',
    setup(build) {
      build.onEnd(result => {
        if (result.errors.length === 0) {
          copyInstrumentationFiles();
          copyVendorFiles(); copyGuide();
        }
      });
    },
  };
  esbuild
    .context({ ...config, plugins: [onRebuild] })
    .then(ctx => {
      copyInstrumentationFiles();
      copyVendorFiles(); copyGuide();
      return ctx.watch();
    })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  esbuild
    .build(config)
    .then(() => { copyInstrumentationFiles(); copyVendorFiles(); copyGuide(); })
    .catch(e => { console.error(e); process.exit(1); });
}
