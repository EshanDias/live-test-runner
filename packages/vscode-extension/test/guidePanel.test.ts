import { guideHtml } from '../src/views/GuidePanel';

describe('guideHtml', () => {
  it('adds a CSP and gives every inline script the nonce', () => {
    const html = guideHtml('<html><head><title>G</title></head><body><script>a()</script><script>b()</script></body></html>', 'vscode-resource:', 'N0');
    expect(html).toMatch(/<head>\n<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'nonce-N0'/);
    expect(html.match(/<script nonce="N0">/g)).toHaveLength(2);
    expect(html).not.toMatch(/<script>/);
  });
});
