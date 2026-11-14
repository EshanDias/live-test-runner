/**
 * "Live Test Runner: Connect Your AI Assistant" — one page with a tab per
 * assistant: what to do, the command to copy, and whether it is already
 * connected. Nothing is written anywhere by this page: the user runs the
 * command (their action, their choice of scope). The page loads nothing
 * remote (rule 11: CSP `default-src 'none'`, inline style, one nonce script).
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PROJECT_SNIPPET } from './instructions';
import { findNode, installNodeHint } from './nodeRuntime';
import { TOOLS } from './catalog';
import { logger } from '../utils/logger';

const log = logger.scope('AI');

export interface ConnectModel {
  editor: string;
  bridgeOn: boolean;
  /** How this editor's own assistant gets the tools without setup. */
  builtIn: 'copilot' | 'cursor' | undefined;
  /** Absolute path of Node.js, if found. */
  node: string | undefined;
  launcher: string;
  platform: NodeJS.Platform;
}

interface Tab { id: string; title: string; status?: string; body: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A path as one shell argument (POSIX single quotes; Windows double quotes). */
export function shellArg(p: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') { return `"${p.replace(/"/g, '""')}"`; }
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The setup commands for terminal agents (Node by absolute path; agents started from a GUI have a short PATH). */
export function setupCommands(node: string, launcher: string, platform: NodeJS.Platform): { claude: string; codex: string; gemini: string; json: string } {
  const n = shellArg(node, platform);
  const l = shellArg(launcher, platform);
  return {
    claude: `claude mcp add --scope user live-test-runner -- ${n} ${l}`,
    codex: `codex mcp add live-test-runner -- ${n} ${l}`,
    gemini: `gemini mcp add --scope user live-test-runner ${n} ${l}`,
    json: JSON.stringify({ mcpServers: { 'live-test-runner': { command: node, args: [launcher] } } }, null, 2),
  };
}

export function connectAiHtml(m: ConnectModel, nonce: string): string {
  const node = m.node ?? (m.platform === 'win32' ? 'node.exe' : 'node');
  const cmd = setupCommands(node, m.launcher, m.platform);
  const code = (id: string, text: string) => `<div class="code"><pre id="${id}">${esc(text)}</pre><button class="copy" data-copy="${id}" title="Copy">Copy</button></div>`;
  const nodeNote = m.node
    ? `<p class="muted">Uses Node.js at <code>${esc(m.node)}</code>.</p>`
    : `<p class="warn">Node.js was not found on this computer. Terminal assistants need it to start Live Test Runner's connection. ${esc(installNodeHint())} If Node is installed somewhere else, replace <code>node</code> below with its full path.</p>`;
  const terminal = (name: string, command: string, extra = '') => `
    <p>Run this once in a terminal. It adds Live Test Runner to ${name} for every project (it is stored in ${name}'s own settings, nothing goes into your project):</p>
    ${code(`cmd-${name.replace(/\W/g, '')}`, command)}
    ${nodeNote}
    <p>Then start ${name} in a folder that is open in ${esc(m.editor)} and ask, for example: <em>“use Live Test Runner to fix the failing tests”</em>.${extra}</p>`;

  const tabs: Tab[] = [
    {
      id: 'copilot',
      title: 'GitHub Copilot',
      status: m.builtIn === 'copilot' ? 'Connected automatically' : undefined,
      body: m.builtIn === 'copilot'
        ? `<p>Nothing to set up: Copilot Chat in agent mode sees Live Test Runner's ${TOOLS.length} tools (named <code>LTR_…</code>). Ask, for example: <em>“why does the add test fail? use Live Test Runner”</em>, or click <strong>✨ Fix with AI</strong> on a failing test.</p>
           <p class="muted">Copilot asks before it runs a tool. Choose which tools it may use with the tools button in the chat box.</p>`
        : `<p>Copilot uses the tools automatically in VS Code 1.95 or newer with GitHub Copilot Chat. ${m.editor.includes('Visual Studio Code') ? 'Update VS Code (Help → Check for Updates) and install GitHub Copilot Chat.' : `${esc(m.editor)} does not offer VS Code's chat tools.`}</p>`,
    },
    {
      id: 'cursor',
      title: 'Cursor',
      status: m.builtIn === 'cursor' ? 'Connected automatically' : undefined,
      body: m.builtIn === 'cursor'
        ? `<p>Nothing to set up: Cursor's agent sees Live Test Runner's tools. If they do not show, open Cursor Settings → MCP and check that <strong>live-test-runner</strong> is on.</p>`
        : `<p>In Cursor, Live Test Runner registers its tools by itself: open this project in Cursor with Live Test Runner installed. To add it by hand (Cursor Settings → MCP → Add new global MCP server), use:</p>${code('cmd-cursor', cmd.json)}${nodeNote}`,
    },
    { id: 'claude', title: 'Claude Code', body: terminal('Claude Code', cmd.claude, ' Type <code>/</code> to see Live Test Runner\'s ready-made tasks, such as <code>/mcp__live-test-runner__LTR_fix_failing_tests</code>.') },
    { id: 'codex', title: 'Codex CLI', body: terminal('Codex', cmd.codex) },
    { id: 'gemini', title: 'Gemini CLI', body: terminal('Gemini CLI', cmd.gemini) },
    {
      id: 'other',
      title: 'Other assistants',
      body: `<p>Windsurf, Cline, Continue and other assistants that support MCP servers: add this to the assistant's <strong>global</strong> MCP settings (each has its own place; look for “MCP servers”):</p>
        ${code('cmd-json', cmd.json)}${nodeNote}
        <p class="muted">If you add it to a project's own settings file instead, add that file to <code>.gitignore</code>: the paths above are on your computer only.</p>`,
    },
    {
      id: 'tips',
      title: 'Tips',
      body: `<p>Assistants pick tools by their descriptions, so you can simply ask: <em>“ask Live Test Runner for the failures”</em>, <em>“which tests cover this function?”</em>, <em>“write tests for the untested code in src/cart.ts”</em>.</p>
        <p>To make your assistant always use it in this project, add these lines to your own instructions file (<code>CLAUDE.md</code>, <code>AGENTS.md</code> or <code>.github/copilot-instructions.md</code>):</p>
        ${code('cmd-snippet', PROJECT_SNIPPET)}
        <p class="muted">The assistant and ${esc(m.editor)} must run on the same computer (with Remote-SSH, WSL or containers, run the assistant where the extension runs).</p>`,
    },
  ];

  const off = m.bridgeOn ? '' : `<div class="banner">The AI assistant connection is off. <button id="turnOn">Turn it on</button> <span class="muted">(setting <code>liveTestRunner.ai.bridge</code>)</span></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect your AI assistant</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; max-width: 900px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .lead { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { background: none; border: none; color: var(--vscode-foreground); padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; opacity: .8; }
  .tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: 600; }
  .tab .ok { color: var(--vscode-testing-iconPassed, #3fb950); margin-left: 4px; }
  .panel { display: none; padding: 12px 0; line-height: 1.5; }
  .panel.active { display: block; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: .9em; margin-bottom: 4px; }
  .code { position: relative; background: var(--vscode-textCodeBlock-background); border-radius: 4px; margin: 8px 0; }
  .code pre { margin: 0; padding: 10px 70px 10px 12px; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .copy, #turnOn { position: absolute; top: 6px; right: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font: inherit; }
  #turnOn { position: static; }
  .muted { color: var(--vscode-descriptionForeground); }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .banner { padding: 8px 12px; margin-bottom: 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground, transparent); }
  code { font-family: var(--vscode-editor-font-family); }
  .privacy { margin-top: 20px; font-size: .9em; }
</style>
</head><body>
<h1>Connect your AI assistant</h1>
<p class="lead">Let your AI assistant read live test results, failures, output and coverage, and rerun tests, while it works. The extension only answers your assistant's questions: it calls no AI service and opens no network port.</p>
${off}
<div class="tabs" role="tablist">
${tabs.map((t, i) => `<button class="tab" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-selected="${i === 0}">${esc(t.title)}${t.status ? '<span class="ok">●</span>' : ''}</button>`).join('\n')}
</div>
${tabs.map((t, i) => `<section class="panel${i === 0 ? ' active' : ''}" id="panel-${t.id}" role="tabpanel">${t.status ? `<div class="status">✓ ${esc(t.status)}</div>` : ''}${t.body}</section>`).join('\n')}
<p class="privacy muted">What your assistant can see and do: test names, errors, console output, coverage and source lines, as Copy for AI does; it can run tests like ▶ Run (never Start or Stop). Turn off runs with <code>liveTestRunner.ai.allowRuns</code>, or everything with <code>liveTestRunner.ai.bridge</code>. See PRIVACY.md.</p>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || {};
  function show(id) {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + id));
    vscode.setState({ tab: id });
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  if (state.tab && document.getElementById('panel-' + state.tab)) { show(state.tab); }
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => {
    const text = document.getElementById(b.dataset.copy).textContent;
    vscode.postMessage({ type: 'copy', text });
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));
  const on = document.getElementById('turnOn');
  if (on) { on.addEventListener('click', () => vscode.postMessage({ type: 'turnOn' })); }
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'show') { show(e.data.tab); } });
</script>
</body></html>`;
}

let panel: vscode.WebviewPanel | undefined;

/** Opens (or refreshes) the page; `tab` picks the assistant shown first. */
export function openConnectAi(model: () => ConnectModel, tab?: string): void {
  const render = () => { if (panel) { panel.webview.html = connectAiHtml(model(), crypto.randomBytes(16).toString('base64')); } };
  if (panel) {
    panel.reveal();
    render();
  } else {
    panel = vscode.window.createWebviewPanel('liveTestRunner.connectAI', 'Connect Your AI Assistant', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
    });
    render();
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; text?: string }) => {
      if (msg?.type === 'copy' && typeof msg.text === 'string') {
        await vscode.env.clipboard.writeText(msg.text);
      } else if (msg?.type === 'turnOn') {
        await vscode.workspace.getConfiguration('liveTestRunner').update('ai.bridge', true, vscode.ConfigurationTarget.Global);
        setTimeout(render, 300);
      }
    });
    log.info('Connect your AI assistant opened');
  }
  if (tab) { void panel.webview.postMessage({ type: 'show', tab }); }
}

/** The page's model from the bridge's state. */
export function connectModel(bridge: { enabled: boolean; builtIn: 'copilot' | 'cursor' | undefined; launcherPath: string }): ConnectModel {
  return {
    editor: vscode.env.appName,
    bridgeOn: bridge.enabled,
    builtIn: bridge.enabled ? bridge.builtIn : undefined,
    node: findNode(),
    launcher: bridge.launcherPath,
    platform: process.platform,
  };
}
