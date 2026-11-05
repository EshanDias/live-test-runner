import { invertMatch, keptShare, matchLines, splitLines } from '../src/editor/lineMatch';

const map = (a: string[], b: string[]) => Array.from(matchLines(a, b));

describe('matchLines (coverage bars follow edits)', () => {
  const file = ['function add(a, b) {', '  return a + b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}'];

  it('maps every line to itself when nothing changed', () => {
    expect(map(file, file)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('shifts the lines below an inserted line; the new line has no measured line', () => {
    const edited = ['// note', ...file];
    expect(map(file, edited)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
  });

  it('shifts the lines below a deleted line', () => {
    const edited = [...file.slice(0, 3), ...file.slice(4)];
    expect(map(file, edited)).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('an edited line has no measured line; its neighbours keep theirs', () => {
    const edited = [...file];
    edited[1] = '  return a + b + 0;';
    expect(map(file, edited)).toEqual([0, -1, 2, 3, 4, 5, 6]);
  });

  it('matches lines in the middle of a larger change', () => {
    const edited = [file[0], '  const s = a + b;', '  return s;', file[2], file[3], file[4], 'x', file[5], file[6]];
    expect(map(file, edited)).toEqual([0, -1, -1, 2, 3, 4, -1, 5, 6]);
  });

  it('handles an emptied file and a file written from nothing', () => {
    expect(map(file, [''])).toEqual([3]); // the one blank line
    expect(map(file, ['x'])).toEqual([-1]);
    expect(map([''], file)).toEqual([-1, -1, -1, 0, -1, -1, -1]);
  });

  it('invertMatch gives each measured line its current line', () => {
    const edited = ['// note', ...file.slice(0, 3), ...file.slice(4)];
    expect(Array.from(invertMatch(matchLines(file, edited), file.length))).toEqual([1, 2, 3, -1, 4, 5, 6]);
  });

  it('splitLines counts lines like the editor (LF, CRLF, trailing newline)', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
  });
});

describe('matchLines — owner rules (2026-11-05)', () => {
  const file = ['function f(a) {', '  const x = a + 1;', '  return x * 2;', '}', '', 'function g() {', '  log("g called");', '  return 1;', '}'];

  it('spacing inside or at the end of a line is not an edit', () => {
    const edited = [...file];
    edited[1] = '  const x  =  a+1;   '.replace('a+1', 'a + 1');
    edited[2] = '  return x * 2;   ';
    expect(map(file, edited)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('changed indentation is an edit (code wrapped in a new if has no bar)', () => {
    const edited = [file[0], '  if (a) {', '    const x = a + 1;', '    return x * 2;', '  }', ...file.slice(3)];
    const m = map(file, edited);
    expect(m.slice(1, 5)).toEqual([-1, -1, -1, -1]);
    expect(m[0]).toBe(0);
    expect(m.slice(5)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('moved code has no bar, nor the lines it moved across', () => {
    // g() moved above f()
    const edited = [...file.slice(5), '', ...file.slice(0, 4)];
    const m = map(file, edited);
    const kept = m.filter((v) => v >= 0).map((v) => file[v].trim()).filter((t) => t.length >= 4);
    expect(kept).toEqual([]);
  });

  it('keptShare: share of non-blank measured lines still in place', () => {
    expect(keptShare(file, invertMatch(matchLines(file, file), file.length))).toBe(1);
    const rewritten = ['// new', 'const z = 1;', ...file.slice(6, 8)]; // 2 of 8 non-blank lines left
    expect(keptShare(file, invertMatch(matchLines(file, rewritten), file.length))).toBeLessThan(0.5);
  });
});
