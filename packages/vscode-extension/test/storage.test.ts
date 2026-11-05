import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearAll, pruneUnused } from '../src/cache/Storage';

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-storage-'));
  const cacheDir = path.join(root, 'cache');
  const tmpDir = path.join(root, 'tmp');
  const mk = (p: string, content?: string) => {
    if (content === undefined) { fs.mkdirSync(p, { recursive: true }); } else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
    return p;
  };
  return { root, cacheDir, tmpDir, mk };
}
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
const old = (p: string, days: number) => { const t = new Date(Date.now() - days * 86_400_000); fs.utimesSync(p, t, t); };

describe('Storage — clear all', () => {
  it('removes every cache except other live windows\' sessions and locked projects; empties our own session folder', () => {
    const { cacheDir, tmpDir, mk } = layout();
    const own = mk(path.join(tmpDir, 'session-100-1'));
    mk(path.join(own, 'trace.jsonl'), 'x');
    const otherLive = mk(path.join(tmpDir, 'session-200-1'));
    const dead = mk(path.join(tmpDir, 'session-300-1'));
    const transform = mk(path.join(tmpDir, 'transform-cache-abc'));
    const runnable = mk(path.join(tmpDir, 'runnable-files-1234.json'), '{}');
    const locked = mk(path.join(cacheDir, 'open-proj-aaaa1111'));
    mk(path.join(locked, 'session.lock'), '200');
    const unlocked = mk(path.join(cacheDir, 'old-proj-bbbb2222'));
    mk(path.join(unlocked, 'session.lock'), '300');
    const cra = mk(path.join(cacheDir, 'ltr-cra-config-x.json'), '{}');

    clearAll({ ownSessionDir: own, isProcessAlive: alive([100, 200]), cacheDir, tmpDir });

    expect(fs.existsSync(own)).toBe(true);
    expect(fs.readdirSync(own)).toEqual([]);
    expect(fs.existsSync(otherLive)).toBe(true);
    expect(fs.existsSync(locked)).toBe(true);
    for (const gone of [dead, transform, runnable, unlocked, cra]) { expect(fs.existsSync(gone)).toBe(false); }
  });
});

describe('Storage — prune unused', () => {
  it('deletes what was not used for 30 days; keeps recent and open projects', () => {
    const { cacheDir, tmpDir, mk } = layout();
    const oldTransform = mk(path.join(tmpDir, 'transform-cache-old'));
    const newTransform = mk(path.join(tmpDir, 'transform-cache-new'));
    const oldRunnable = mk(path.join(tmpDir, 'runnable-files-old.json'), '{}');
    const session = mk(path.join(tmpDir, 'session-1-1'));
    const oldCra = mk(path.join(cacheDir, 'ltr-cra-config-old.json'), '{}');
    const oldProject = mk(path.join(cacheDir, 'p-old'));
    mk(path.join(oldProject, 'discovery-cache.json'), JSON.stringify({ lastUsedAt: Date.now() - 40 * 86_400_000 }));
    const recentProject = mk(path.join(cacheDir, 'p-new'));
    mk(path.join(recentProject, 'discovery-cache.json'), JSON.stringify({ lastUsedAt: Date.now() - 2 * 86_400_000 }));
    const openOldProject = mk(path.join(cacheDir, 'p-open'));
    mk(path.join(openOldProject, 'discovery-cache.json'), JSON.stringify({ lastUsedAt: Date.now() - 90 * 86_400_000 }));
    mk(path.join(openOldProject, 'session.lock'), '42');
    for (const p of [oldTransform, oldRunnable, oldCra, session]) { old(p, 45); }

    pruneUnused({ isProcessAlive: alive([42]), cacheDir, tmpDir });

    for (const gone of [oldTransform, oldRunnable, oldCra, oldProject]) { expect(fs.existsSync(gone)).toBe(false); }
    for (const kept of [newTransform, recentProject, openOldProject, session]) { expect(fs.existsSync(kept)).toBe(true); }
  });
});
