'use strict';
/**
 * ▷ Debug on a Vitest project: the CodeLens builds a launch config for
 * Vitest's own CLI (vitest.mjs run <file> -t …, child processes
 * auto-attached), VS Code accepts it, and the config runs exactly the chosen
 * test / suite / test.each rows.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../lib/harness');

const FILE = 'src/math.test.js';

/** Runs a debug launch config with plain node and returns how many tests passed / failed. */
function runConfig(config) {
  const env = { ...process.env, ...config.env, CI: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const out = path.join(os.tmpdir(), `ltr-e2e-vdebug-${Date.now()}.json`);
  spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args, '--reporter=json', `--outputFile=${out}`], {
    cwd: config.cwd, encoding: 'utf8', env, timeout: 120_000,
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
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const terminated = [];
    vscode.debug.onDidTerminateDebugSession((s) => terminated.push(s.name));

    const test = h.nodeByName(api, FILE, 'Math utils adds numbers');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(test.fileId));
    await vscode.window.showTextDocument(doc);

    const config = await lensDebug(vscode, doc, test.line);
    t.check('▷ Debug started a debug session', !!config, 'debugFromEditor returned nothing');
    if (!config) { return; }
    t.info(`program: ${config.program}`);
    t.info(`args: ${JSON.stringify(config.args)}`);
    t.check('program is Vitest\'s CLI entry and exists', /vitest\.mjs$/.test(config.program) && fs.existsSync(config.program), config.program);
    t.eq('cwd is the project root', config.cwd.toLowerCase(), workspace.toLowerCase());
    t.eq('child processes are auto-attached (tests run in workers)', config.autoAttachChildProcesses, true);
    t.check('runs one file at a time without timeouts', ['--no-file-parallelism', '--test-timeout=0'].every((a) => config.args.includes(a)), JSON.stringify(config.args));
    await h.waitFor(() => terminated.length > 0, { what: 'the debug session to end', timeout: 90_000 });

    t.eq('the config runs only "Math utils adds numbers"', runConfig(config), { passed: 1, failed: 0 });

    const suite = h.nodeByName(api, FILE, 'Math utils divide');
    const suiteConfig = await lensDebug(vscode, doc, suite.line);
    t.eq('suite debug runs the suite\'s 2 tests', suiteConfig ? runConfig(suiteConfig) : null, { passed: 2, failed: 0 });

    const each = h.allNodes(api).find((n) => n.isDynamicTemplate && n.name === 'add(%i, %i) = %i');
    const eachConfig = each ? await lensDebug(vscode, doc, each.line) : undefined;
    t.eq('test.each debug runs both generated tests', eachConfig ? runConfig(eachConfig) : null, { passed: 2, failed: 0 });
  },
};
