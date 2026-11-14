/**
 * Finds the user's Node.js for the setup commands of terminal agents. An
 * agent started from a GUI often has a shorter PATH than the terminal, so
 * the copied command names Node by its absolute path. Only looks at files:
 * no process is started.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXE = process.platform === 'win32' ? 'node.exe' : 'node';

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** The places Node is usually installed beyond PATH (newest nvm / fnm version last). */
function commonDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) { dirs.push(path.join(base, 'nodejs')); }
    }
    if (process.env.NVM_SYMLINK) { dirs.push(process.env.NVM_SYMLINK); }
    if (process.env.APPDATA) { dirs.push(path.join(process.env.APPDATA, 'nvm')); }
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.volta', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.asdf', 'shims'));
    for (const managed of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.local', 'share', 'fnm', 'node-versions')]) {
      try {
        const versions = fs.readdirSync(managed).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const newest = versions.pop();
        if (newest) { dirs.push(path.join(managed, newest, 'bin'), path.join(managed, newest, 'installation', 'bin')); }
      } catch { /* not installed */ }
    }
  }
  return dirs;
}

/** Absolute path of a Node.js on this machine, or undefined. */
export function findNode(envPath = process.env.PATH ?? ''): string | undefined {
  const fromPath = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...commonDirs()]) {
    const p = path.join(dir, EXE);
    if (isFile(p)) { return p; }
  }
  return undefined;
}

/** How to get Node, per OS, for the setup page. */
export function installNodeHint(): string {
  switch (process.platform) {
    case 'darwin': return 'Install Node.js from nodejs.org (or `brew install node`), then reopen this page.';
    case 'win32': return 'Install Node.js from nodejs.org (or `winget install OpenJS.NodeJS`), then reopen this page.';
    default: return 'Install Node.js from nodejs.org or your package manager (e.g. `sudo apt install nodejs`), then reopen this page.';
  }
}
