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
 * Files from session/instrumentation  → session-wide tracing (sessionTraceTransform/Runtime)
 */
function copyInstrumentationFiles() {
  const dest = path.join(__dirname, 'out', 'instrumentation');
  fs.mkdirSync(dest, { recursive: true });

  const timelineSrc = path.join(__dirname, 'src', 'timeline', 'instrumentation');
  for (const file of ['traceTransform.js', 'traceRuntime.js']) {
    fs.copyFileSync(path.join(timelineSrc, file), path.join(dest, file));
  }

  const sessionSrc = path.join(__dirname, 'src', 'session', 'instrumentation');
  for (const file of ['sessionTraceTransform.js', 'sessionTraceRuntime.js']) {
    fs.copyFileSync(path.join(sessionSrc, file), path.join(dest, file));
  }
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
        }
      });
    },
  };
  esbuild
    .context({ ...config, plugins: [onRebuild] })
    .then(ctx => {
      copyInstrumentationFiles();
      return ctx.watch();
    })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  esbuild
    .build(config)
    .then(() => copyInstrumentationFiles())
    .catch(e => { console.error(e); process.exit(1); });
}
