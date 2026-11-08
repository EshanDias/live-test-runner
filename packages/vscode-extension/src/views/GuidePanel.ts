/**
 * "Live Test Runner: Open Guide" — shows the user guide that ships with the
 * extension (out/guide/guide.html, copied from docs/ at build time) in an
 * editor tab. It works offline, always matches the installed version and
 * loads nothing from the network: its pictures are links to the same page
 * published online with GitHub Pages (GUIDE_URL), opened only when clicked.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

const log = logger.scope('Guide');

/** The guide published with GitHub Pages. */
export const GUIDE_URL = 'https://eshandias.github.io/live-test-runner/guide/';

let panel: vscode.WebviewPanel | undefined;

/**
 * Adds a CSP so the guide's theme toggle and nav highlight run (inline styles,
 * the page's scripts by nonce) and nothing loads from another origin.
 */
export function guideHtml(raw: string, cspSource: string, nonce: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
  return raw
    .replace(/<head>/i, `<head>\n${csp}`)
    .replace(/<script>/gi, `<script nonce="${nonce}">`);
}

export async function openGuide(extensionUri: vscode.Uri): Promise<void> {
  if (panel) { panel.reveal(); return; }
  const file = vscode.Uri.joinPath(extensionUri, 'out', 'guide', 'guide.html');
  let raw: string;
  try {
    raw = fs.readFileSync(file.fsPath, 'utf8');
  } catch (err) {
    // A dev build without the copy step. The browser opens only if the user asks.
    log.warn(`Guide not found at ${file.fsPath}`, err);
    const open = 'Open Online Guide';
    if (await vscode.window.showWarningMessage('The guide is missing from this build of Live Test Runner.', open) === open) {
      await vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    }
    return;
  }
  panel = vscode.window.createWebviewPanel('liveTestRunner.guide', 'Live Test Runner Guide', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  panel.webview.html = guideHtml(raw, panel.webview.cspSource, crypto.randomBytes(16).toString('base64'));
  panel.onDidDispose(() => { panel = undefined; });
  log.info('Guide opened');
}
