'use strict';
/**
 * New tests and ▶ Run after Stop, for one framework:
 *  - session on: a test file created on disk (no editor save) runs by itself,
 *    and so does a test case added to it;
 *  - after Stop: ▶ Run works (Stop ends what was in flight, not later clicks),
 *    on a known file and on a test file created after Stop (the framework is
 *    asked for its file list again).
 */
const fs = require('fs');
const path = require('path');
const h = require('./harness');

/**
 * @param cfg.dir       folder for the new test files ('src', 'tests')
 * @param cfg.file      (name) => file name of a new test file
 * @param cfg.body      [one test, a second test to append]; each passes
 */
async function newTestsAndStopScenario({ api, t, vscode, workspace }, cfg) {
  const passed = (rel) => { try { return h.statusCounts(api, rel).passed ?? 0; } catch { return 0; } };
  await h.waitForDiscovery(api);
  await vscode.commands.executeCommand('liveTestRunner.startTesting');
  await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
  await h.settle(api);

  // ── Session on: written on disk, never saved in the editor ──
  const onRel = `${cfg.dir}/${cfg.file('created_on')}`;
  const onFile = path.join(workspace, ...onRel.split('/'));
  fs.writeFileSync(onFile, cfg.body[0]);
  await h.waitFor(() => passed(onRel) === 1, { what: `${onRel} to run`, timeout: 60_000 }).catch(() => {});
  await h.settle(api);
  t.eq('session on: a test file created on disk runs by itself', passed(onRel), 1);
  fs.appendFileSync(onFile, cfg.body[1]);
  await h.waitFor(() => passed(onRel) === 2, { what: 'the added test to run', timeout: 60_000 }).catch(() => {});
  await h.settle(api);
  t.eq('session on: a test case added on disk runs by itself', passed(onRel), 2);

  // ── After Stop: explicit runs still work ──
  const known = h.fileBySuffix(api, onRel);
  await vscode.commands.executeCommand('liveTestRunner.stopTesting');
  await h.settle(api);
  fs.appendFileSync(onFile, cfg.body[1].replace(/two/g, 'three'));
  await api.session.rerunScope({ scope: 'file', fileId: known.fileId });
  await h.settle(api);
  t.eq('after Stop: ▶ Run on a test file runs it (and sees its new test)', passed(onRel), 3);

  const offRel = `${cfg.dir}/${cfg.file('created_off')}`;
  const offFile = path.join(workspace, ...offRel.split('/'));
  fs.writeFileSync(offFile, cfg.body[0]);
  await h.waitFor(() => { try { return h.fileBySuffix(api, offRel); } catch { return undefined; } }, { what: `${offRel} to be discovered`, timeout: 30_000 });
  await api.session.rerunScope({ scope: 'file', fileId: h.fileBySuffix(api, offRel).fileId });
  await h.settle(api);
  t.eq('after Stop: ▶ Run on a test file created after Stop runs it', passed(offRel), 1);
  t.check('…and Stop stays final: the session is still off', !api.session.isActive());
}

module.exports = { newTestsAndStopScenario };
