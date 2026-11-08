import { statementLines } from '../src/coverage/statementLines';

const st = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const lines = (m: Map<number, string[]>) => Object.fromEntries([...m].sort(([a], [b]) => a - b));

describe('statementLines', () => {
  it('a one-line statement marks its line', () => {
    expect(lines(statementLines({ statements: { 0: st(3, 2, 3, 20) } }))).toEqual({ 3: ['0'] });
  });

  it('a statement over several lines with nothing inside marks every line (return { … })', () => {
    expect(lines(statementLines({ statements: { 0: st(2, 2, 5, 4) } }))).toEqual({ 2: ['0'], 3: ['0'], 4: ['0'], 5: ['0'] });
  });

  it('a statement holding others marks only its first line (const f = () => { … })', () => {
    const m = statementLines({ statements: {
      0: st(1, 0, 6, 2),   // const f = () => {
      1: st(2, 2, 2, 10),  //   a();
      2: st(4, 2, 5, 9),   //   return b(   (two lines, nothing inside)
    } });
    expect(lines(m)).toEqual({ 1: ['0'], 2: ['1'], 4: ['2'], 5: ['2'] });
  });

  it('a statement that starts on the line another ends on shares the line', () => {
    const m = statementLines({ statements: { 0: st(1, 0, 3, 2), 1: st(3, 4, 3, 10) } });
    expect(lines(m)).toEqual({ 1: ['0'], 2: ['0'], 3: ['0', '1'] });
  });

  it('two statements starting at the same place: the outer one holds the inner', () => {
    const m = statementLines({ statements: { 1: st(1, 0, 1, 5), 0: st(1, 0, 4, 1) } });
    expect(lines(m)).toEqual({ 1: ['0', '1'] });
  });
});
