/**
 * The way in for agents outside the editor: the MCP relay finds the window
 * (bridge.json), passes tool calls through the file mailbox and returns the
 * answers. Tested in-process, and with the shipped out/mcp.js started the
 * way an agent starts it (through the launcher).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { MailboxServer } from '../src/ai/mailbox';
import { BRIDGE_FILE, BridgeInfo, PROTOCOL_VERSION } from '../src/ai/protocol';
import { McpRelay } from '../src/ai/mcp/server';
import { chooseWindow } from '../src/ai/mcp/discovery';
import { installLauncher, LAUNCHER_SOURCE, launcherPaths } from '../src/ai/launcher';
import { TOOLS } from '../src/ai/catalog';
import { setupCommands, shellArg } from '../src/ai/ConnectAiPanel';

jest.mock('vscode', () => ({}), { virtual: true });

const EXT = path.resolve(__dirname, '..');
let tmp: string;
let workspace: string;
let sessionDir: string;
let server: MailboxServer | undefined;

function info(over: Partial<BridgeInfo> = {}): BridgeInfo {
  return { protocol: PROTOCOL_VERSION, version: '3.5.0', pid: process.pid, startedAt: 1000, workspaceRoots: [workspace], sessionDir, editor: 'Visual Studio Code', ...over };
}

const quiet = { debug: () => undefined, warn: () => undefined };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-bridge-')));
  workspace = path.join(tmp, 'my project');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  sessionDir = path.join(tmp, 'tmproot', `session-${process.pid}-1000`);
});

afterEach(() => {
  server?.dispose();
  server = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startWindow(handler = async (req: { tool: string; args: Record<string, unknown> }) => ({ text: JSON.stringify({ tool: req.tool, args: req.args }) })) {
  server = new MailboxServer(sessionDir, info(), handler, quiet, 50);
  server.start();
}

function relay(over: Partial<ConstructorParameters<typeof McpRelay>[0]> = {}) {
  const sent: any[] = [];
  const r = new McpRelay({ send: (m) => sent.push(m), workspace: path.join(workspace, 'src'), version: '3.5.0', tmpRoot: path.join(tmp, 'tmproot'), ...over });
  return { r, sent };
}

describe('window discovery', () => {
  it('picks the window whose folder holds the agent\'s folder', () => {
    startWindow();
    expect(chooseWindow({ workspace: path.join(workspace, 'src'), tmpRoot: path.join(tmp, 'tmproot') }).chosen?.sessionDir).toBe(sessionDir);
    expect(chooseWindow({ workspace: path.join(tmp, 'elsewhere'), tmpRoot: path.join(tmp, 'tmproot') }).chosen).toBeUndefined();
  });

  it('ignores a window whose process is gone', () => {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, BRIDGE_FILE), JSON.stringify(info({ pid: 2 ** 22 + 12345 })));
    expect(chooseWindow({ workspace, tmpRoot: path.join(tmp, 'tmproot') }).chosen).toBeUndefined();
  });

  it('LTR_SESSION_DIR names the window exactly', () => {
    startWindow();
    expect(chooseWindow({ workspace: '/', sessionDir }).chosen?.sessionDir).toBe(sessionDir);
  });
});

describe('MCP relay (in process)', () => {
  it('initialize: version, capabilities and the instructions', async () => {
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test' } } });
    expect(sent[0].result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'live-test-runner' }, capabilities: { tools: {}, prompts: {} } });
    expect(sent[0].result.instructions).toMatch(/LTR_get_failures/);
  });

  it('tools/list and prompts/list come from the catalog', async () => {
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await r.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    expect(sent[0].result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(sent[0].result.tools.find((t: { name: string }) => t.name === 'LTR_get_failures').annotations.readOnlyHint).toBe(true);
    expect(sent[1].result.prompts.length).toBeGreaterThan(3);
  });

  it('tools/call goes through the mailbox and back', async () => {
    startWindow();
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'LTR_get_failures', arguments: { limit: 3 } } });
    expect(sent[0].id).toBe(7);
    expect(JSON.parse(sent[0].result.content[0].text)).toEqual({ tool: 'LTR_get_failures', args: { limit: 3 } });
    // Nothing is left behind in the mailbox.
    expect(fs.readdirSync(path.join(sessionDir, 'bridge', 'requests'))).toEqual([]);
    expect(fs.readdirSync(path.join(sessionDir, 'bridge', 'responses'))).toEqual([]);
  });

  it('get_status says which window answered', async () => {
    startWindow(async () => ({ text: JSON.stringify({ projects: [] }) }));
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'LTR_get_status', arguments: {} } });
    expect(JSON.parse(sent[0].result.content[0].text).window).toEqual({ editor: 'Visual Studio Code', folders: [workspace] });
  });

  it('no window: a clear answer, not a hang', async () => {
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'LTR_get_failures', arguments: {} } });
    expect(sent[0].result.isError).toBe(true);
    expect(sent[0].result.content[0].text).toMatch(/Open this folder in VS Code/);
  });

  it('unknown methods and tools are JSON-RPC errors; notifications get no answer', async () => {
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'nope' });
    await r.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'LTR_nope' } });
    await r.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(sent.map((m) => m.error?.code)).toEqual([-32601, -32602]);
  });

  it('prompts/get fills the arguments in', async () => {
    const { r, sent } = relay();
    await r.handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'LTR_explain_failure', arguments: { test: 'Math adds' } } });
    expect(sent[0].result.messages[0].content.text).toContain('Math adds');
  });
});

describe('the shipped relay, started like an agent does', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(EXT, 'out', 'mcp.js'))) {
      const r = spawnSync(process.execPath, ['esbuild.js'], { cwd: EXT, encoding: 'utf8' });
      if (r.status !== 0) { throw new Error(`build failed: ${r.stderr || r.stdout}`); }
    }
  }, 120_000);

  it('the launcher starts out/mcp.js; a tool call reaches the window', async () => {
    startWindow(async (req) => ({ text: JSON.stringify({ answered: req.tool }) }));
    const globalDir = path.join(tmp, 'global storage');
    const paths = installLauncher(globalDir, path.join(EXT, 'out', 'mcp.js'), '3.5.0', info());
    expect(fs.readFileSync(paths.launcher, 'utf8')).toBe(LAUNCHER_SOURCE);
    expect(fs.readdirSync(paths.windows)).toEqual([`${path.basename(sessionDir)}.json`]);

    // The agent's temp folder differs from the editor's: the pointer in the storage folder finds the window.
    const child = spawn(process.execPath, [paths.launcher], { cwd: workspace, env: { ...process.env, TMPDIR: path.join(tmp, 'agent-tmp'), TMP: path.join(tmp, 'agent-tmp'), TEMP: path.join(tmp, 'agent-tmp') } });
    const lines: any[] = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    const waitFor = async (id: number) => {
      for (let t = 0; t < 100; t++) { const m = lines.find((x) => x.id === id); if (m) { return m; } await new Promise((r) => setTimeout(r, 50)); }
      throw new Error(`no answer to ${id}; got ${JSON.stringify(lines)}`);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jest' } } });
      expect((await waitFor(1)).result.serverInfo.version).toBe(require('../package.json').version);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'LTR_get_failures', arguments: {} } });
      expect(JSON.parse((await waitFor(2)).result.content[0].text)).toEqual({ answered: 'LTR_get_failures' });
    } finally {
      child.kill();
    }
  }, 30_000);

  it('the launcher explains itself when the extension is gone', () => {
    const globalDir = path.join(tmp, 'gs');
    const p = launcherPaths(globalDir);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.launcher, LAUNCHER_SOURCE);
    const r = spawnSync(process.execPath, [p.launcher], { encoding: 'utf8', input: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Live Test Runner extension/);
  });
});

describe('setup commands', () => {
  it('quote paths with spaces for the shell', () => {
    expect(shellArg('/usr/local/bin/node', 'darwin')).toBe('/usr/local/bin/node');
    expect(shellArg("/Users/a/Library/Application Support/x's.js", 'darwin')).toBe(`'/Users/a/Library/Application Support/x'\\''s.js'`);
    expect(shellArg('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    const c = setupCommands('/opt/node', '/a b/l.js', 'linux');
    expect(c.claude).toBe(`claude mcp add --scope user live-test-runner -- /opt/node '/a b/l.js'`);
    expect(c.gemini).toContain('--scope user');
    expect(JSON.parse(c.json).mcpServers['live-test-runner']).toEqual({ command: '/opt/node', args: ['/a b/l.js'] });
  });
});
