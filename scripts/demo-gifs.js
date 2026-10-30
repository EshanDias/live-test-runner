#!/usr/bin/env node
'use strict';
/**
 * Builds the README / website GIFs from the demo recordings
 * (e2e/lib/demo.js, scenarios diag-demo-*):
 *
 *   FFMPEG=/path/to/ffmpeg node scripts/demo-gifs.js <shots dir> [<out dir>]
 *
 * Writes to <out dir> (default packages/vscode-extension/resources/gifs):
 *   demo.gif          the README hero: the scenes below one after another, each with a caption
 *   scene-<name>.gif  each scene on its own, no caption (the website slider captions it)
 * ffmpeg is not a dependency of this repo — pass any build with drawtext
 * (e.g. the `ffmpeg-static` npm package installed in a temp folder).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const [shots, outArg] = process.argv.slice(2);
if (!shots) { console.error('usage: FFMPEG=… node scripts/demo-gifs.js <shots dir> [<out dir>]'); process.exit(2); }
const OUT = path.resolve(outArg || path.join(__dirname, '..', 'packages', 'vscode-extension', 'resources', 'gifs'));

const WIDTH = 1024;  // GIF width; READMEs show ~900 px
const FPS = 8;
const BAR = 46;      // caption bar height
const FONT = ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));

// [recording, caption, seconds to cut from the start, seconds to hold the last frame, speed-up]
const SCENES = [
  ['jest-run', 'Click Start — every test runs, results stream in live (Jest)', 0.8, 1.5, 1.4],
  ['vitest-save', 'Save a file — only the tests that use it rerun (Vitest)', 0.5, 1.5, 1.8],
  ['pytest-run', 'pytest too — same tree, live results, gutter icons', 0.8, 1.5, 1.4],
  ['pytest-hover', 'Hover a line — see exactly which tests ran it', 0.5, 2, 1],
  ['jest-results', '▶ Run one test — its own console output', 0.5, 2, 1.5],
];

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) { throw new Error(`ffmpeg failed: ${args.join(' ')}`); }
}

/** A recording → a lossless clip at FPS with its caption bar. */
function clip(tmp, name, caption, cut, hold, speed, withCaption) {
  const dir = path.join(shots, name);
  const frames = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  const lines = [];
  for (let i = 0; i < frames.length - 1; i++) {
    lines.push(`file '${path.join(dir, frames[i].file).replace(/'/g, "'\\''")}'`, `duration ${(frames[i + 1].t - frames[i].t).toFixed(3)}`);
  }
  lines.push(`file '${path.join(dir, frames[frames.length - 2].file).replace(/'/g, "'\\''")}'`);
  const list = path.join(tmp, `${name}.txt`);
  fs.writeFileSync(list, lines.join('\n'));
  const text = caption.replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:');
  const vf = [
    `setpts=PTS/${speed}`,
    `fps=${FPS}`,
    `scale=${WIDTH}:-2:flags=lanczos`,
    ...(withCaption ? [
      `pad=iw:ih+${BAR}:0:${BAR}:color=0x181818`,
      `drawtext=fontfile='${FONT}':text='${text}':fontcolor=white:fontsize=21:x=(w-text_w)/2:y=(${BAR}-text_h)/2`,
    ] : []),
    `tpad=stop_mode=clone:stop_duration=${hold}`,
  ].join(',');
  const outFile = path.join(tmp, `${name}${withCaption ? '-c' : ''}.mkv`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-ss', String(cut), '-vf', vf, '-c:v', 'ffv1', outFile]);
  return outFile;
}

function gif(inputs, outFile) {
  const n = inputs.length;
  const concat = n > 1 ? `${inputs.map((_, i) => `[${i}:v]`).join('')}concat=n=${n}:v=1:a=0[v];[v]` : '[0:v]';
  const filter = `${concat}split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  ff([...inputs.flatMap((f) => ['-i', f]), '-filter_complex', filter, '-loop', '0', outFile]);
  console.log(`${path.relative(process.cwd(), outFile)}  ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-gifs-'));
fs.mkdirSync(OUT, { recursive: true });
gif(SCENES.map(([name, caption, cut, hold, speed]) => clip(tmp, name, caption, cut, hold, speed, true)), path.join(OUT, 'demo.gif'));
for (const [name, caption, cut, hold, speed] of SCENES) { gif([clip(tmp, name, caption, cut, hold, speed, false)], path.join(OUT, `scene-${name}.gif`)); }
fs.rmSync(tmp, { recursive: true, force: true });
