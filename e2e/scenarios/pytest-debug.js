'use strict';
/**
 * ▷ Debug on a pytest project. Without the Python Debugger extension
 * (ms-python.debugpy — not installed in the e2e VS Code) the CodeLens says
 * what to install and starts nothing. The launch config it builds is the
 * Python Debugger's own (`type: debugpy`, `module: pytest`, the project's
 * interpreter) and, run with that interpreter, selects exactly the chosen
 * test / class / parametrized function.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const h = require('../lib/harness');

const FILE = 'tests/test_cart.py';

/** Runs a debugpy launch config with its own python (`python -m pytest …args`); returns pytest's counts. */
function runConfig(config) {
  const r = spawnSync(config.python, ['-m', config.module, ...config.args, '-q'], {
    cwd: config.cwd, encoding: 'utf8', env: { ...process.env, ...config.env }, timeout: 120_000,
  });
  const summary = (r.stdout || '').split('\n').reverse().find((l) => /\d+ (passed|failed)/.test(l)) || '';
  const n = (what) => Number((new RegExp(`(\\d+) ${what}`).exec(summary) || [0, 0])[1]);
  return { passed: n('passed'), failed: n('failed') };
}

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const test = h.nodeByName(api, FILE, 'TestCart test_add');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(test.fileId));
    await vscode.window.showTextDocument(doc);

    const since = h.isoNow();
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
    const lens = lenses.find((l) => l.range.start.line === test.line - 1 && l.command && l.command.title === '▷ Debug');
    t.check('the test has a ▷ Debug lens', !!lens);
    const started = lens ? await vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments) : undefined;
    t.check('without the Python Debugger nothing starts', !started);
    const logs = h.logsSince(api, since);
    t.check('…and the log names the extension to install', logs.some((l) => /ms-python\.debugpy/.test(l)), logs.join('\n'));

    const adapter = api.projects.selected.services.servicesFor(test.fileId).adapter;
    const config = await adapter.buildDebugConfig(workspace, test.fileId, test.fullName, false);
    t.eq('a Python Debugger launch of pytest', [config.type, config.request, config.module], ['debugpy', 'launch', 'pytest']);
    t.check("…with the project's .venv python", /[\\/]\.venv[\\/]/.test(config.python), config.python);
    t.check('…without our plugin (a plain pytest)', !config.args.includes('ltr_pytest'), JSON.stringify(config.args));
    t.eq('…from the project root', path.resolve(config.cwd), path.resolve(workspace));
    t.eq('the config runs only "TestCart test_add"', runConfig(config), { passed: 1, failed: 0 });

    const cls = h.nodeByName(api, FILE, 'TestCart');
    t.eq("a class's config runs its tests", runConfig(await adapter.buildDebugConfig(workspace, cls.fileId, cls.fullName, true)), { passed: 5, failed: 1 });
    const tpl = h.allNodes(api).find((n) => n.isDynamicTemplate && n.fullName === 'test_discount[…]');
    t.eq("a parametrized function's config runs every case", runConfig(await adapter.buildDebugConfig(workspace, tpl.fileId, tpl.fullName, true)), { passed: 3, failed: 0 });
  },
};
