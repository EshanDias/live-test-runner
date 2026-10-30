'use strict';
/** DevTools-protocol helpers for the diag-screenshots scenarios (VS Code started with LTR_E2E_CDP_PORT). */
const fs = require('fs');
const path = require('path');

/** One DevTools session on the workbench page. */
async function devtools(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url)) ?? targets.find((t) => t.type === 'page');
  if (!page) { throw new Error(`no workbench page on port ${port}: ${JSON.stringify(targets.map((t) => t.url))}`); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (msg.method) { for (const cb of listeners.get(msg.method) ?? []) { cb(msg.params); } return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  };
  const on = (method, cb) => { listeners.set(method, [...(listeners.get(method) ?? []), cb]); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, on, close: () => ws.close() };
}

/**
 * `shot(name, clip?)`: waits for the UI to settle, writes <out>/<name>.png (1440×900 at 2×; `clip` in CSS px).
 * Clips start at y = 36 to leave out the title bar ("[Extension Development Host]", Sign In).
 */
async function shooter(cdp, out, t) {
  fs.mkdirSync(out, { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  return async (name, clip) => {
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
    t.check(`captured ${name}.png`, true);
  };
}

/**
 * `record(name, clip)` captures screenshots in a loop (as fast as the window
 * renders them, ~5–10 a second) into <out>/<name>/NNNNN.png + frames.json
 * ([{ file, t }], t in seconds; the last entry is the end time); the
 * returned `stop()` ends it. Screenshots, not Page.startScreencast: the
 * screencast leaves webviews (Explorer, Results) blank. `clip` in CSS px,
 * captured at 1× from the 2× window (sharp text). scripts/demo-gifs.js turns
 * a recording into a GIF.
 */
function recorder(cdp, out) {
  return async (name, clip) => {
    const dir = path.join(out, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    let running = true;
    const loop = (async () => {
      while (running) {
        const t = Date.now() / 1000;
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 0.5 } });
        const file = `${String(frames.length).padStart(5, '0')}.png`;
        fs.writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
        frames.push({ file, t });
      }
    })();
    return async () => {
      running = false;
      await loop;
      frames.push({ file: null, t: Date.now() / 1000 });
      fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
      return frames.length - 1;
    };
  };
}

module.exports = { devtools, shooter, recorder };
