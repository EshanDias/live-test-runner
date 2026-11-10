'use strict';
/**
 * ▷ Debug on an Angular test: the project's Angular CLI (`ng test <project>`)
 * under the debugger for that file and test, output in the Debug Console,
 * child processes attached; the session ends, and the config run with plain
 * node runs only that test.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../lib/harness');

const FILE = 'src/app/cart.spec.ts';

function runConfig(config) {
  const env = { ...process.env, ...config.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const out = path.join(os.tmpdir(), `ltr-e2e-ngdebug-${Date.now()}.json`);
  spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args, '--reporters', 'json', '--output-file', out], {
    cwd: config.cwd, encoding: 'utf8', env, timeout: 180_000,
  });
  if (!fs.existsSync(out)) { return 'no result'; }
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  return { passed: json.numPassedTests, failed: json.numFailedTests };
}

async function lensDebug(vscode, doc, line) {
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
  const lens = lenses.find((l) => l.range.start.line === line - 1 && l.command && l.command.title === '▷ Debug');
  if (!lens) { throw new Error(`no ▷ Debug lens on line ${line}`); }
  return vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments);
}

module.exports = {
  workspace: 'fixture:angular',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const running = new Set();
    vscode.debug.onDidStartDebugSession((s) => { if (!s.parentSession) { running.add(s.id); } });
    vscode.debug.onDidTerminateDebugSession((s) => running.delete(s.id));

    const test = h.nodeByName(api, FILE, 'Cart adds items');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(test.fileId));
    await vscode.window.showTextDocument(doc);
    const config = await lensDebug(vscode, doc, test.line);
    t.check('▷ Debug started a debug session', !!config, 'debugFromEditor returned nothing');
    if (!config) { return; }
    t.info(`args: ${JSON.stringify(config.args)}`);
    t.check('program is the project\'s Angular CLI', /@angular[\\/]cli[\\/]bin[\\/]ng\.js$/.test(config.program) && fs.existsSync(config.program), config.program);
    t.eq('ng test <project> for the one file and test', config.args.slice(0, 5), ['test', 'shop', '--watch=false', '--include', FILE]);
    t.eq('started directly, output in the Debug Console, workers attached', [config.console, config.outputCapture, config.autoAttachChildProcesses], ['internalConsole', 'std', true]);
    await h.waitFor(() => running.size === 0, { what: 'the debug session to end', timeout: 120_000 });

    t.eq('the config runs only "Cart adds items"', runConfig(config), { passed: 1, failed: 0 });
    t.check('nothing written into the project', !fs.existsSync(path.join(workspace, '.angular')), fs.readdirSync(workspace).join(', '));
  },
};
