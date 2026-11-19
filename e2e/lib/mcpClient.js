'use strict';
/**
 * A scripted MCP client for the e2e scenarios: starts the extension's MCP
 * relay the way a terminal agent does (the launcher in the extension's
 * storage folder, from the workspace folder) and speaks JSON-RPC over stdio.
 * Runs inside the extension host, whose Node is Electron's: ELECTRON_RUN_AS_NODE.
 */
const { spawn } = require('child_process');

function startMcp(launcher, cwd, env = {}) {
  const child = spawn(process.execPath, [launcher], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const stderr = [];
  let buf = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { stderr.push(`not JSON on stdout: ${line}`); continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on('data', (d) => stderr.push(String(d)));

  function request(method, params, timeout = 120_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method}: no answer in ${timeout} ms (${stderr.join('')})`)); }, timeout);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });
  }

  /** A tool call; resolves to the parsed JSON answer (+ isError). */
  async function call(name, args = {}) {
    const msg = await request('tools/call', { name, arguments: args });
    if (msg.error) { throw new Error(`${name}: ${msg.error.message}`); }
    const text = msg.result.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = { text }; }
    return { ...body, isError: !!msg.result.isError };
  }

  /** Polls LTR_get_run until the run is over. */
  async function finish(answer) {
    let a = answer;
    for (let i = 0; i < 20 && a.runId && (a.state === 'running' || a.state === 'queued'); i++) {
      a = await call('LTR_get_run', { runId: a.runId, wait: 30 });
    }
    return a;
  }

  async function initialize() {
    const msg = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ltr-e2e', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return msg.result;
  }

  return { child, request, call, finish, initialize, stderr, close: () => child.kill() };
}

module.exports = { startMcp };
