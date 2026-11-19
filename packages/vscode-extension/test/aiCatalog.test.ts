/**
 * The AI tools are defined once (src/ai/catalog.ts). VS Code reads them from
 * package.json (`contributes.languageModelTools`), so that block must match
 * the catalog. Regenerate it with:
 *
 *   UPDATE_LM_TOOLS=1 npx jest test/aiCatalog.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { TOOLS, PROMPTS, promptText } from '../src/ai/catalog';
import { toolModelDescription, INSTRUCTIONS } from '../src/ai/instructions';

const PKG = path.join(__dirname, '..', 'package.json');

function expectedLmTools(): unknown[] {
  return TOOLS.map((t) => ({
    name: t.name,
    toolReferenceName: t.name,
    displayName: `Live Test Runner: ${t.title}`,
    userDescription: t.description.split('. ')[0].replace(/\.$/, '') + '.',
    modelDescription: toolModelDescription(t.description),
    canBeReferencedInPrompt: true,
    icon: '$(beaker)',
    tags: ['tests', 'live-test-runner'],
    when: 'config.liveTestRunner.ai.bridge',
    inputSchema: t.inputSchema,
  }));
}

describe('AI tool catalog', () => {
  it('package.json declares exactly the catalog\'s tools for VS Code', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    const want = expectedLmTools();
    if (process.env.UPDATE_LM_TOOLS) {
      pkg.contributes.languageModelTools = want;
      fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
    }
    expect(pkg.contributes.languageModelTools).toEqual(want);
  });

  it('every tool is prefixed, unique and has a usable schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^LTR_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      for (const r of t.inputSchema.required ?? []) { expect(Object.keys(t.inputSchema.properties)).toContain(r); }
    }
  });

  it('never exposes Start, Stop, settings or arbitrary commands', () => {
    const names = TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/LTR_(start|stop)|_stop_session|setting|command|exec|shell|clear_all/i);
  });

  it('the instructions and prompts name only real tools', () => {
    const mentioned = [INSTRUCTIONS, ...PROMPTS.map((p) => p.text)].join('\n').match(/LTR_[a-z_]+/g) ?? [];
    const known = new Set([...TOOLS.map((t) => t.name), ...PROMPTS.map((p) => p.name)]);
    expect(mentioned.filter((m) => !known.has(m))).toEqual([]);
  });

  it('prompt arguments fill in, with a sensible default when missing', () => {
    const p = PROMPTS.find((x) => x.name === 'LTR_write_tests_for')!;
    expect(promptText(p, { file: 'src/cart.ts' })).toContain('src/cart.ts');
    expect(promptText(p, {})).toContain('the least covered code');
  });
});
