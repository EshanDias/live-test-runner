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
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

/** `shot(name, clip?)`: waits for the UI to settle, writes <out>/<name>.png (1440×900 at 2×; `clip` in CSS px). */
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

module.exports = { devtools, shooter };
