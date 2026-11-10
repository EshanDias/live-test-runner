import { parseFailure } from '../src/editor/failureInfo';

describe('parseFailure', () => {
  it('Jest toBe: single values and the test file frame', () => {
    const f = parseFailure([
      'Error: expect(received).toBe(expected) // Object.is equality',
      '',
      'Expected: 3',
      'Received: 4',
      '    at Object.toBe (/p/src/math.test.js:12:17)',
      '    at Promise.then.completed (/p/node_modules/jest-circus/build/utils.js:298:28)',
      '    at new Promise (<anonymous>)',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n'));
    expect(f.summary).toBe('Expected 3, received 4');
    expect([f.expected, f.actual]).toEqual(['3', '4']);
    expect(f.frames).toEqual([{ file: '/p/src/math.test.js', line: 12, column: 17 }]);
    expect(f.message).not.toMatch(/\bat\b.*utils\.js|<anonymous>/);
  });

  it('Jest toEqual: both sides rebuilt from the diff', () => {
    const f = parseFailure([
      'Error: expect(received).toEqual(expected) // deep equality',
      '',
      '- Expected  - 1',
      '+ Received  + 1',
      '',
      '  Object {',
      '-   "a": 1,',
      '+   "a": 2,',
      '    "b": 3,',
      '  }',
      '    at Object.toEqual (C:\\p\\src\\obj.test.ts:7:22)',
    ].join('\n'));
    expect(f.expected).toBe('Object {\n  "a": 1,\n  "b": 3,\n}');
    expect(f.actual).toBe('Object {\n  "a": 2,\n  "b": 3,\n}');
    expect(f.summary).toBe('expect(received).toEqual(expected) // deep equality');
    expect(f.frames).toEqual([{ file: 'C:\\p\\src\\obj.test.ts', line: 7, column: 22 }]);
  });

  it('Jest labelled values (toContain)', () => {
    const f = parseFailure('Error: expect(received).toContain(expected) // indexOf\n\nExpected substring: "abc"\nReceived string:    "xyz"\n    at Object.toContain (/p/a.test.js:3:1)');
    expect([f.expected, f.actual]).toEqual(['"abc"', '   "xyz"']);
  });

  it('an error thrown in a source file: its frame first, then the test', () => {
    const f = parseFailure([
      "TypeError: Cannot read properties of undefined (reading 'x')",
      '    at add (/p/src/math.js:3:10)',
      '    at Object.<anonymous> (/p/src/math.test.js:5:3)',
    ].join('\n'));
    expect(f.summary).toBe("TypeError: Cannot read properties of undefined (reading 'x')");
    expect(f.frames.map((x) => x.file)).toEqual(['/p/src/math.js', '/p/src/math.test.js']);
    expect(f.expected).toBeUndefined();
  });

  it('Vitest error text: diff and a relative location', () => {
    const f = parseFailure([
      'AssertionError: expected 4 to be 3 // Object.is equality',
      '',
      '- Expected',
      '+ Received',
      '',
      '- 3',
      '+ 4',
      '',
      '❯ src/math.test.ts:5:17',
    ].join('\n'));
    expect([f.expected, f.actual]).toEqual(['3', '4']);
    expect(f.summary).toBe('Expected 3, received 4');
    expect(f.frames).toEqual([{ file: 'src/math.test.ts', line: 5, column: 17 }]);
  });

  it('a Jest snapshot diff: the snapshot is the expected side', () => {
    const f = parseFailure('Error: expect(received).toMatchSnapshot()\n\nSnapshot name: `a 1`\n\n- Snapshot  - 1\n+ Received  + 1\n\n- "old"\n+ "new"\n    at Object.toMatchSnapshot (/p/a.test.js:4:9)');
    expect([f.expected, f.actual]).toEqual(['"old"', '"new"']);
  });

  it('pytest: the E line, and the test location before the code it called', () => {
    const f = parseFailure([
      '    def test_add():',
      '>       assert add(1, 2) == 4',
      'E       assert 3 == 4',
      'E        +  where 3 = add(1, 2)',
      '',
      'tests/test_math.py:5: AssertionError',
    ].join('\n'));
    expect(f.summary).toBe('assert 3 == 4');
    expect(f.frames).toEqual([{ file: 'tests/test_math.py', line: 5 }]);
  });

  it('pytest with a frame in the source: innermost first', () => {
    const f = parseFailure([
      '    def test_div():',
      '>       div(1, 0)',
      '',
      'tests/test_math.py:9: ',
      '_ _ _ _',
      '    def div(a, b):',
      '>       return a / b',
      'E       ZeroDivisionError: division by zero',
      '',
      'src/calc.py:2: ZeroDivisionError',
    ].join('\n'));
    expect(f.summary).toBe('ZeroDivisionError: division by zero');
    expect(f.frames.map((x) => `${x.file}:${x.line}`)).toEqual(['src/calc.py:2', 'tests/test_math.py:9']);
  });

  it('a long first line is cut', () => {
    expect(parseFailure(`Error: ${'x'.repeat(400)}`).summary).toHaveLength(160);
  });
});

describe('snapshot failures', () => {
  it.each([
    ['Error: expect(received).toMatchSnapshot()\n\nSnapshot name: `a 1`', 'file'],
    ['Error: expect(received).toThrowErrorMatchingSnapshot()', 'file'],
    ['Error: Snapshot `renders 1` mismatched\n\n- Expected\n+ Received', 'file'],
    ['Error: expect(received).toMatchInlineSnapshot(snapshot)\n\nSnapshot: "a"', 'inline'],
    ['Error: expect(received).toBe(expected)', undefined],
  ])('%s', (message, kind) => {
    expect(parseFailure(message).snapshot).toBe(kind);
  });
});
