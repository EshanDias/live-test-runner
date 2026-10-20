'use strict';
/**
 * ▷ Debug (BUG-05, BUG-06): the CodeLens debugs only its own test, the launch
 * config is runnable on this OS (path with spaces), and VS Code accepts it.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const h = require('../lib/harness');

const FILE = 'src/math.test.js';

/** Runs a debug launch config with plain node and returns Jest's test summary. */
function runConfig(config) {
  const env = { ...process.env, ...config.env, CI: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args], {
    cwd: config.cwd, encoding: 'utf8', env, timeout: 120_000,
  });
  const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/);
  const summaries = h.jestTestSummaries(lines);
  if (summaries.length === 0) {
    summaries.push({ error: String(r.error || ''), status: r.status, tail: lines.filter(Boolean).slice(-8).join(' / ') });
  }
  return summaries;
}

async function lensDebug(vscode, doc, line) {
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
  const lens = lenses.find((l) => l.range.start.line === line - 1 && l.command && l.command.title === '▷ Debug');
  if (!lens) { throw new Error(`no ▷ Debug lens on line ${line}`); }
  return vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments);
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const terminated = [];
    vscode.debug.onDidTerminateDebugSession((s) => terminated.push(s.name));

    const test = h.nodeByName(api, FILE, 'Math utils adds numbers');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(test.fileId));
    await vscode.window.showTextDocument(doc);

    const config = await lensDebug(vscode, doc, test.line);
    t.check('BUG-05 ▷ Debug started a debug session', !!config, 'debugFromEditor returned nothing');
    if (!config) { return; }
    t.info(`program: ${config.program}`);
    t.info(`args: ${JSON.stringify(config.args)}`);
    t.check('BUG-06 program is a JS file that exists', /\.js$/.test(config.program) && fs.existsSync(config.program), config.program);
    t.eq('BUG-06 cwd is the project root', config.cwd.toLowerCase(), workspace.toLowerCase());
    await h.waitFor(() => terminated.length > 0, { what: 'the debug session to end', timeout: 90_000 });

    t.eq('BUG-05 debug config runs only "Math utils adds numbers"', runConfig(config).map((s) => s.passed ?? s), [1]);

    // A describe block debugs every test in it.
    const suite = h.nodeByName(api, FILE, 'Math utils');
    const suiteConfig = await lensDebug(vscode, doc, suite.line);
    t.eq('BUG-05 suite debug runs the suite\'s 4 tests', suiteConfig ? runConfig(suiteConfig).map((s) => s.passed ?? s) : null, [4]);

    // test.each template: placeholders must match the generated names.
    const each = h.nodeByName(api, 'src/strings.test.js', 'Strings shout(%s) is %s');
    const eachDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(each.fileId));
    const eachConfig = await lensDebug(vscode, eachDoc, each.line);
    t.eq('BUG-06 test.each debug runs both generated tests', eachConfig ? runConfig(eachConfig).map((s) => s.passed ?? s) : null, [2]);
  },
};
