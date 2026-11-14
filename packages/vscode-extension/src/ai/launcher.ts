/**
 * The MCP launcher: a tiny script in the extension's own storage folder
 * (VS Code's globalStorage for this extension, stable across updates), so
 * the command a user gives their agent never changes. It loads the current
 * extension's relay (out/mcp.js), whose folder changes with every update.
 *
 *   <globalStorage>/mcp/live-test-runner-mcp.js   the launcher
 *   <globalStorage>/mcp/current.json              { server, version }: where the relay is now
 *   <globalStorage>/mcp/windows/<session>.json    one pointer per open window (its bridge.json),
 *                                                 for agents whose temp folder differs from the editor's
 *
 * Nothing is written outside the extension's own folders (rule 9).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BridgeInfo, isProcessAlive, readJson, writeJsonAtomic } from './protocol';

export const LAUNCHER_NAME = 'live-test-runner-mcp.js';

/** The launcher's source (plain Node, CommonJS). */
export const LAUNCHER_SOURCE = `#!/usr/bin/env node
// Live Test Runner — MCP server launcher. Written by the Live Test Runner
// extension into its own storage folder; it starts the installed extension's
// MCP relay (which talks to your editor window through local files only).
'use strict';
const fs = require('fs');
const path = require('path');
let current;
try { current = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8')); } catch (e) { current = undefined; }
if (!current || typeof current.server !== 'string' || !fs.existsSync(current.server)) {
  process.stderr.write('Live Test Runner: the extension was not found. Open VS Code (or Cursor) with the Live Test Runner extension once, then restart your agent.\\n');
  process.exit(1);
}
process.env.LTR_POINTER_DIR = path.join(__dirname, 'windows');
require(current.server);
`;

export interface LauncherPaths {
  dir: string;
  launcher: string;
  windows: string;
}

export function launcherPaths(globalStorageDir: string): LauncherPaths {
  const dir = path.join(globalStorageDir, 'mcp');
  return { dir, launcher: path.join(dir, LAUNCHER_NAME), windows: path.join(dir, 'windows') };
}

/**
 * Writes / refreshes the launcher and points it at this extension's relay;
 * announces this window and removes pointers of closed ones.
 */
export function installLauncher(globalStorageDir: string, serverPath: string, version: string, info: BridgeInfo): LauncherPaths {
  const p = launcherPaths(globalStorageDir);
  fs.mkdirSync(p.windows, { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(p.launcher, 'utf8'); } catch { /* first time */ }
  if (existing !== LAUNCHER_SOURCE) { fs.writeFileSync(p.launcher, LAUNCHER_SOURCE, { mode: 0o755 }); }
  writeJsonAtomic(path.join(p.dir, 'current.json'), { server: serverPath, version });
  for (const name of fs.readdirSync(p.windows)) {
    const other = readJson<BridgeInfo>(path.join(p.windows, name));
    if (!other || !isProcessAlive(other.pid) || !fs.existsSync(other.sessionDir)) {
      try { fs.rmSync(path.join(p.windows, name), { force: true }); } catch { /* another window got it */ }
    }
  }
  writeJsonAtomic(path.join(p.windows, `${path.basename(info.sessionDir)}.json`), info);
  return p;
}

/** The window closes: its pointer goes. */
export function removeWindowPointer(globalStorageDir: string, sessionDir: string): void {
  try { fs.rmSync(path.join(launcherPaths(globalStorageDir).windows, `${path.basename(sessionDir)}.json`), { force: true }); } catch { /* pruned next time */ }
}
