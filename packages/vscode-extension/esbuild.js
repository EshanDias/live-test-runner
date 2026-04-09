const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

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
  esbuild.context(config).then(ctx => ctx.watch()).catch(() => process.exit(1));
} else {
  esbuild.build(config).catch(() => process.exit(1));
}
