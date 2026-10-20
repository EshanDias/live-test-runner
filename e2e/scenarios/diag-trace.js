'use strict';
/**
 * Diagnostic: runs one small test file of LTR_E2E_CRA_REPO and keeps the raw
 * session trace file (trace-copy.jsonl next to the report) for inspection.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'env:LTR_E2E_CRA_REPO',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    const file = api.store.getAllFiles()
      .filter((f) => f.rootNodeIds.length > 0)
      .map((f) => ({ id: f.fileId, size: fs.statSync(f.fileId).size }))
      .sort((a, b) => a.size - b.size)
      .find((f) => /textFormatUtils/.test(f.id)) || { id: api.store.getAllFiles()[0].fileId };
    const runner = api.session._traceRunner;
    const orig = runner._parseTrace.bind(runner);
    const out = path.join(path.dirname(process.env.LTR_E2E_REPORT), 'trace-copy.jsonl');
    runner._parseTrace = (traceFile, ...rest) => {
      t.info(`trace file exists: ${fs.existsSync(traceFile)}`);
      if (fs.existsSync(traceFile)) { fs.copyFileSync(traceFile, out); }
      return orig(traceFile, ...rest);
    };
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: file.id });
    if (fs.existsSync(out)) {
      const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
      t.info(`${lines.length} record(s)`);
      for (const l of lines.slice(0, 6)) { t.info(l.slice(0, 300)); }
    }
    t.check('diagnostic ran', true);
  },
};
