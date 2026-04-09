const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const watch  = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** Copy traceTransform.js and traceRuntime.js to out/instrumentation/ after each build. */
function copyInstrumentationFiles() {
  const src  = path.join(__dirname, 'src', 'timeline', 'instrumentation');
  const dest = path.join(__dirname, 'out', 'instrumentation');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['traceTransform.js', 'traceRuntime.js']) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
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
  sourcemap: true,
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
    .catch(() => process.exit(1));
} else {
  esbuild
    .build(config)
    .then(() => copyInstrumentationFiles())
    .catch(() => process.exit(1));
}
