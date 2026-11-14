'use strict';
/**
 * Kills what a scenario's VS Code left running: every process whose command line names the run's
 * own user-data folder (the window, its helpers, the extension host) and all their descendants
 * (test processes). The launched process can exit while the window it handed off to keeps running,
 * and a SIGKILL of one process leaves its children behind.
 */
const { spawnSync } = require('child_process');

function processTable() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    let rows = [];
    try { rows = JSON.parse(r.stdout || '[]'); } catch { return []; }
    if (!Array.isArray(rows)) { rows = [rows]; }
    return rows.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine || '' }));
  }
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout || '').split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : undefined;
  }).filter(Boolean);
}

/** Pids of processes naming `marker` in their command line, plus `extraPids`, and all their descendants. */
function leftoverPids(marker, extraPids = []) {
  const table = processTable();
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase().replace(/\//g, '\\') : s);
  const m = norm(marker);
  const found = new Set(extraPids.filter(Boolean));
  for (const p of table) { if (p.pid !== process.pid && norm(p.cmd).includes(m)) { found.add(p.pid); } }
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (!found.has(p.pid) && found.has(p.ppid) && p.pid !== process.pid) { found.add(p.pid); grew = true; }
    }
  }
  const alive = new Set(table.map((p) => p.pid));
  return [...found].filter((pid) => alive.has(pid));
}

/** Kills the leftovers; returns how many processes it killed. */
function killLeftovers(marker, extraPids = []) {
  const pids = leftoverPids(marker, extraPids);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      else { process.kill(pid, 'SIGKILL'); }
    } catch { /* already gone */ }
  }
  return pids.length;
}

module.exports = { killLeftovers, leftoverPids };
