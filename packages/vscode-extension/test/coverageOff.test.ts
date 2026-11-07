import { CoverageStore } from '../src/coverage/CoverageStore';

describe('CoverageStore off reasons', () => {
  it('totals carry why coverage is off, until the next clear', () => {
    const store = new CoverageStore();
    expect(store.getTotals().off).toBeUndefined();
    store.setOffReasons(['pytest: install the coverage package']);
    expect(store.getTotals().off).toEqual(['pytest: install the coverage package']);
    store.clear();
    expect(store.getTotals().off).toBeUndefined();
    store.dispose?.();
  });
});
