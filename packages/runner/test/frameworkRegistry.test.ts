import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrameworkRegistry, ADAPTER_PRIORITIES } from '../src/framework/FrameworkRegistry';
import { FrameworkDetector, _resetDetectorWarnings } from '../src/framework/FrameworkDetector';
import { FrameworkAdapter } from '../src/framework/adapters/FrameworkAdapter';
import { setLogSink } from '../src/utils/logger';

/** A minimal adapter that matches when `matches` is true (or throws when it is 'throw'). */
function fake(framework: string, matches: boolean | 'throw'): FrameworkAdapter {
  return {
    framework,
    detect: () => { if (matches === 'throw') { throw new Error('boom'); } return matches; },
    capabilities: () => ({ results: true, nameFilter: true, listTests: true, related: true, liveStream: true, coverage: true }),
    resolveBinary: () => '',
    resolveConfig: async () => undefined,
    getExtraArgs: () => [],
    outputFileArg: (f) => [f],
    parseResult: () => ({ passed: true, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, fileResults: [], errors: [] }),
    createRunner: () => { throw new Error('not used'); },
  };
}

describe('FrameworkRegistry', () => {
  it('keeps the shipped order: CRA, then Vitest, then Jest', () => {
    expect(FrameworkRegistry.default().adapters().map((a) => a.framework)).toEqual(['cra', 'vitest', 'jest']);
    expect(ADAPTER_PRIORITIES.cra).toBeGreaterThan(ADAPTER_PRIORITIES.vitest);
    expect(ADAPTER_PRIORITIES.vitest).toBeGreaterThan(ADAPTER_PRIORITIES.jest);
  });

  it('orders by priority, then registration order', () => {
    const r = new FrameworkRegistry()
      .register(fake('low', false), 1)
      .register(fake('high', false), 9)
      .register(fake('mid-a', false), 5)
      .register(fake('mid-b', false), 5);
    expect(r.adapters().map((a) => a.framework)).toEqual(['high', 'mid-a', 'mid-b', 'low']);
  });

  it('replaces an adapter registered again under the same id', () => {
    const r = new FrameworkRegistry().register(fake('x', false), 1).register(fake('x', true), 7);
    expect(r.adapters()).toHaveLength(1);
    expect(r.get('x')?.detect('')).toBe(true);
    expect(r.unregister('x')).toBe(true);
    expect(r.unregister('x')).toBe(false);
  });
});

describe('FrameworkDetector with a registry', () => {
  let warnings: string[];
  beforeEach(() => {
    _resetDetectorWarnings();
    warnings = [];
    setLogSink((level, _scope, msg) => { if (level === 'warn') { warnings.push(msg); } });
  });
  afterEach(() => setLogSink(undefined));

  it('returns the first matching adapter and why', () => {
    const r = new FrameworkRegistry().register(fake('a', false), 2).register(fake('b', true), 1);
    const d = new FrameworkDetector(r).detectWithReason('/p');
    expect(d).toMatchObject({ framework: 'b', matched: 'b', reason: 'matched by the "b" adapter' });
  });

  it('skips an adapter whose detection throws, with a warning', () => {
    const r = new FrameworkRegistry().register(fake('bad', 'throw'), 2).register(fake('good', true), 1);
    expect(new FrameworkDetector(r).detectFramework('/p')).toBe('good');
    expect(warnings.some((w) => w.includes('"bad" detection failed'))).toBe(true);
  });

  it('falls back to plain Jest for an unrecognised project, warning once per root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr registry '));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const detector = new FrameworkDetector();
      const d = detector.detectWithReason(dir);
      expect(d).toMatchObject({ framework: 'jest', matched: 'unknown' });
      detector.detect(dir);
      expect(warnings.filter((w) => w.includes('assuming plain Jest'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
