import { guideHtml } from '../src/views/GuidePanel';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { offlineGuide, remoteResources } = require('../src/guide/offlineGuide');

describe('guideHtml', () => {
  it('adds a CSP and gives every inline script the nonce', () => {
    const html = guideHtml('<html><head><title>G</title></head><body><script>a()</script><script>b()</script></body></html>', 'vscode-resource:', 'N0');
    expect(html).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'nonce-N0'/);
    expect(html.match(/<script nonce="N0">/g)).toHaveLength(2);
    expect(html).not.toMatch(/<script>/);
  });

  it('allows no image (or anything else) from another origin', () => {
    const csp = /content="([^"]+)"/.exec(guideHtml('<html><head></head></html>', 'vscode-resource:', 'N'))![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/https?:|\*|wss?:/);
  });
});

describe('offlineGuide (build step for the shipped guide)', () => {
  const page = [
    '<html><head><link rel="canonical" href="https://example.org/guide/"></head><body>',
    '<section id="intro"><img src="https://example.org/a.gif" alt="Tests &amp; results"></section>',
    '<section id="local"><img src="data:image/png;base64,AAAA" alt="inline"></section>',
    '<a href="https://example.org/more" target="_blank" rel="noopener">more</a>',
    '</body></html>',
  ].join('\n');

  it('turns remote pictures into a note linking to the same section online', () => {
    const out = offlineGuide(page, 'https://guide.example/');
    expect(out).not.toContain('https://example.org/a.gif');
    expect(out).toContain('<p class="offline-media">Picture: Tests &amp; results. <a href="https://guide.example/#intro" target="_blank" rel="noopener">See it in the online guide</a>.</p>');
    expect(remoteResources(out)).toEqual([]);
  });

  it('keeps local pictures and plain links, drops the canonical link', () => {
    const out = offlineGuide(page, 'https://guide.example/');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('href="https://example.org/more"');
    expect(out).not.toMatch(/rel="canonical"/);
  });

  it.each([
    ['a remote script', '<script src="https://cdn.example/x.js"></script>'],
    ['a remote stylesheet', '<link rel="stylesheet" href="https://fonts.example/css">'],
    ['a frame', '<iframe src="//video.example/embed"></iframe>'],
    ['a video', '<video poster="https://x.example/p.png"></video>'],
    ['a CSS url()', '<div style="background:url(https://x.example/bg.png)"></div>'],
    ['a CSS @import', '<style>@import url("https://fonts.example/a.css");</style>'],
  ])('fails the build on %s', (_name, html) => {
    expect(() => offlineGuide(`<html><head></head><body>${html}</body></html>`)).toThrow(/remote resources/);
  });
});
