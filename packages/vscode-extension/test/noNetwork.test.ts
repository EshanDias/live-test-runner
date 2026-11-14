/**
 * The extension makes no network calls and collects no telemetry: it runs the
 * user's own test framework locally. This guards that promise (README →
 * Privacy) against regressions, over what actually ships:
 *
 * - the bundle (out/extension.js) loads only the Node modules listed below;
 * - first-party sources (runner, core, extension, instrumentation, webviews,
 *   the pytest plugin) and the shipped third-party code use no network module
 *   or API and no telemetry package;
 * - the packages' dependencies stay free of network, telemetry and AI-service
 *   libraries (AI features hand data to the user's own tools, see PRIVACY.md);
 * - no webview (the guide included) can load anything from another origin.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { guideHtml, GUIDE_URL } from '../src/views/GuidePanel';
import { connectAiHtml } from '../src/ai/ConnectAiPanel';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { remoteResources, GUIDE_URL: BUILD_GUIDE_URL } = require('../src/guide/offlineGuide');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHIPPED: Record<string, string[]> = require('../../../scripts/shipped-packages');

const EXT = path.resolve(__dirname, '..');
const ROOT = path.resolve(EXT, '..', '..');
const OUT = path.join(EXT, 'out');

/**
 * Every module the bundle may require. Each is local-only: `child_process`
 * starts the user's own test framework, `fs` / `os` / `path` read and write the
 * session folder, `crypto` makes ids and nonces, `events` is Node's emitter,
 * `vscode` is the editor API. Adding one here needs a reason in this comment.
 */
const BUNDLE_MODULES = ['child_process', 'crypto', 'events', 'fs', 'os', 'path', 'vscode'];

const NET_MODULE = /(?:require\(\s*|from\s+|import\(\s*|import\s+)['"](?:node:)?(http|https|http2|net|tls|dgram|dns)(?:\/promises)?['"]/;
const NET_API = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\b(?:curl|wget|Invoke-WebRequest)\b/;
const PY_NET = /^\s*(?:import|from)\s+(socket|ssl|urllib|urllib3|http|requests|httpx|aiohttp|ftplib|smtplib|xmlrpc|websocket|websockets)\b/m;

/** Network clients, telemetry / analytics / error-reporting SDKs and AI-service SDKs. */
const BANNED_PACKAGES = [
  'axios', 'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'got', 'ky', 'request', 'superagent', 'needle', 'phin',
  'undici', 'ws', 'socket.io-client', 'faye-websocket',
  '@vscode/extension-telemetry', 'vscode-extension-telemetry', 'applicationinsights', 'posthog-node', 'posthog-js',
  'mixpanel', 'analytics-node', '@segment/analytics-node', 'amplitude', 'newrelic', 'dd-trace', 'rollbar',
  'bugsnag', 'logrocket', 'launchdarkly-node-server-sdk',
  // AI services: AI features hand data to the user's own assistant (clipboard,
  // VS Code's language-model tools, a local MCP server), never to a model directly.
  'openai', 'ai', 'cohere-ai', 'groq-sdk', 'replicate', 'ollama', 'langchain', 'llamaindex',
  '@google/genai', '@google/generative-ai', '@google-cloud/vertexai', '@azure/openai',
];
const BANNED_SCOPES = [
  '@sentry/', '@amplitude/', '@opentelemetry/', '@bugsnag/', '@datadog/', '@segment/', '@posthog/',
  '@anthropic-ai/', '@mistralai/', '@aws-sdk/',
  '@huggingface/', '@langchain/', '@ai-sdk/', '@xenova/',
];
const isBanned = (name: string) => BANNED_PACKAGES.includes(name) || BANNED_SCOPES.some((s) => name.startsWith(s));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const TELEMETRY_IMPORT = new RegExp(`(?:require\\(\\s*|from\\s+|import\\(\\s*)['"](?:${[
  ...BANNED_PACKAGES.map(escapeRe),
  ...BANNED_SCOPES.map((s) => `${escapeRe(s)}[^'"]+`),
].join('|')})['"]`);

function filesUnder(dir: string, exts: RegExp): string[] {
  if (!fs.existsSync(dir)) { return []; }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { return e.name === 'node_modules' ? [] : filesUnder(p, exts); }
    return exts.test(e.name) && !/\.test\.[jt]s$/.test(e.name) ? [p] : [];
  });
}

/** Lines matching `re`, as `file:line: text`. */
function hits(files: string[], re: RegExp): string[] {
  return files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n')
    .map((l, i) => (re.test(l) ? `${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 120)}` : ''))
    .filter(Boolean));
}

/** Sources the CSP may list without reaching another origin. */
function remoteCspSources(csp: string): string[] {
  return csp.split(';').flatMap((d) => d.trim().split(/\s+/).slice(1))
    .filter((s) => !/^'(none|self|unsafe-inline|nonce-[^']+)'$/.test(s) && !/^(data|blob):$/.test(s) && !/^(\{\{cspSource\}\}|\$\{cspSource\}|CSP_SOURCE)$/.test(s));
}
const cspOf = (html: string) => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];

beforeAll(() => {
  if (!fs.existsSync(path.join(OUT, 'extension.js')) || !fs.existsSync(path.join(OUT, 'mcp.js')) || !fs.existsSync(path.join(OUT, 'guide', 'guide.html'))) {
    const r = spawnSync(process.execPath, ['esbuild.js'], { cwd: EXT, encoding: 'utf8' });
    if (r.status !== 0) { throw new Error(`build failed: ${r.stderr || r.stdout}`); }
  }
}, 120_000);

describe('no network calls, no telemetry', () => {
  it('the bundle requires only local Node modules', () => {
    const bundle = fs.readFileSync(path.join(OUT, 'extension.js'), 'utf8');
    const required = [...new Set([...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1].replace(/^node:/, '')))];
    expect(required.filter((m) => !BUNDLE_MODULES.includes(m))).toEqual([]);
    expect(bundle.split('\n').filter((l) => NET_API.test(l)).map((l) => l.trim().slice(0, 120))).toEqual([]);
  });

  it('the MCP relay (out/mcp.js) talks to the editor through files only', () => {
    // An agent starts it; it reads stdin, writes stdout and the window's mailbox files. No socket, no port.
    const relay = fs.readFileSync(path.join(OUT, 'mcp.js'), 'utf8');
    const required = [...new Set([...relay.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1].replace(/^node:/, '')))];
    expect(required.filter((m) => !['crypto', 'fs', 'os', 'path'].includes(m))).toEqual([]);
    expect(relay.split('\n').filter((l) => NET_API.test(l)).map((l) => l.trim().slice(0, 120))).toEqual([]);
  });

  it('first-party sources use no network module or API and no telemetry package', () => {
    const sources = ['packages/runner/src', 'packages/core/src', 'packages/vscode-extension/src']
      .flatMap((d) => filesUnder(path.join(ROOT, d), /\.(ts|js|mjs|cjs|html)$/));
    expect(sources.length).toBeGreaterThan(50);
    expect(hits(sources, NET_MODULE)).toEqual([]);
    expect(hits(sources, NET_API)).toEqual([]);
    expect(hits(sources, TELEMETRY_IMPORT)).toEqual([]);
  });

  it('the shipped pytest plugin imports no network module', () => {
    const py = filesUnder(path.join(ROOT, 'packages/runner/src'), /\.py$/);
    expect(py.length).toBeGreaterThan(0);
    expect(py.filter((f) => PY_NET.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('shipped third-party code and instrumentation use no network module or API', () => {
    const shipped = [...filesUnder(path.join(OUT, 'vendor'), /\.js$/), ...filesUnder(path.join(OUT, 'instrumentation'), /\.(js|mjs)$/)];
    expect(shipped.length).toBeGreaterThan(5);
    expect(hits(shipped, NET_MODULE)).toEqual([]);
    expect(hits(shipped, NET_API)).toEqual([]);
  });

  it('dependencies stay free of network, telemetry and AI-service libraries', () => {
    for (const dir of ['packages/runner', 'packages/core', 'packages/vscode-extension']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
      // Runtime dependencies are only our own packages; third-party code ships through esbuild (SHIPPED).
      const deps = Object.entries<string>(pkg.dependencies ?? {});
      expect(deps.filter(([, v]) => !v.startsWith('workspace:'))).toEqual([]);
      expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).filter(isBanned)).toEqual([]);
    }
    expect(Object.keys(SHIPPED).filter(isBanned)).toEqual([]);
  });
});

describe('webviews load nothing from another origin', () => {
  it('the shipped guide has no auto-loading remote resource', () => {
    const guide = fs.readFileSync(path.join(OUT, 'guide', 'guide.html'), 'utf8');
    expect(remoteResources(guide)).toEqual([]);
    expect(guide).not.toMatch(/<link\b[^>]*rel=["']?canonical/i);
    expect(guide).toContain(`href="${GUIDE_URL}`); // the pictures are links to the online guide
  });

  it('every webview CSP lists only local sources', () => {
    const csps: Record<string, string | undefined> = {
      'explorer.html': cspOf(fs.readFileSync(path.join(EXT, 'src/webview/explorer.html'), 'utf8')),
      'results.html': cspOf(fs.readFileSync(path.join(EXT, 'src/webview/results.html'), 'utf8')),
      guide: cspOf(guideHtml('<html><head></head><body></body></html>', 'CSP_SOURCE', 'N')),
      connectAi: cspOf(connectAiHtml({ editor: 'Visual Studio Code', bridgeOn: true, builtIn: 'copilot', node: '/usr/bin/node', launcher: '/x/l.js', platform: 'linux' }, 'N')),
    };
    for (const [name, csp] of Object.entries(csps)) {
      expect([name, csp && csp.includes("default-src 'none'")]).toEqual([name, true]);
      expect([name, remoteCspSources(csp as string)]).toEqual([name, []]);
    }
  });

  it('the build and the panel use the same online guide URL', () => {
    expect(BUILD_GUIDE_URL).toBe(GUIDE_URL);
  });
});
