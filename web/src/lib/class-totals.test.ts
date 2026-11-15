import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classCardStats, classTotals, nsnRecords, pointDollars } from './class-totals.ts';

const pp = (nsn: string, awardRef: string, over: Record<string, unknown> = {}) => ({
  nsn, awardRef, source: 'dibbs_award', unitPrice: 2, quantity: 10, totalValue: null as number | null, ...over,
});
const act = (awardUid: string, piid: string | null, obligation: number | null, isCeiling = false) => ({ awardUid, piid, obligation, isCeiling });

test('pointDollars: total, else unit price x quantity, else unit price', () => {
  assert.equal(pointDollars({ unitPrice: 2, quantity: 10, totalValue: 25 }), 25);
  assert.equal(pointDollars({ unitPrice: 2, quantity: 10, totalValue: null }), 20);
  assert.equal(pointDollars({ unitPrice: 2, quantity: null, totalValue: null }), 2);
});

test('nsnRecords: a DIBBS award that is a price point and an action counts once; ceilings count never', () => {
  const actions = [act('DIBBS-SPE7M126V0001-70', 'SPE7M126V0001', 100), act('DIBBS-SPE7M126D0003-71', 'SPE7M126D0003', 9e9, true), act('CONT_AWD_X', 'X', 50)];
  const points = [pp('1', 'SPE7M126V0001'), pp('1', 'SPE7M126V0009')]; // the first is the same award as the first action
  const r = nsnRecords(points, actions, () => actions);
  assert.equal(r.records, 3); // 1 point + 2 non-ceiling actions
  assert.equal(r.dollars, 20 + 100 + 50);
});

test('classTotals: sums NSNs in order and adds the category-level actions without their ceilings', () => {
  const actionsByNsn: Record<string, ReturnType<typeof act>[]> = { a: [act('DIBBS-SPE7M126V0001-70', 'SPE7M126V0001', 100)], b: [] };
  const pointsByNsn = { a: [pp('a', 'SPE7M126V0001'), pp('a', 'SPE7M126V0002', { totalValue: 5 })], b: [pp('b', 'SPE7M126V0003')] };
  const t = classTotals(['a', 'b'], (n) => pointsByNsn[n as 'a'], (n) => actionsByNsn[n] ?? [], { count: 4, ceilingCount: 1, obligated: 1000 });
  assert.equal(t.purchases, /* a: 1 point + 1 action, b: 1 point */ 3 + /* class level */ 3);
  assert.equal(t.dollars, 5 + 100 + 20 + 1000);
  assert.deepEqual(classTotals([], () => [], () => [], undefined), { purchases: 0, dollars: 0 });
});

test('classCardStats: open demand when solicitations are on record, catalog counts otherwise', () => {
  assert.deepEqual(classCardStats({ open: 1, closing: 0, onRecord: 12, nsns: 40, purchases: 7 }), [
    { value: '1', label: 'open solicitation' },
    { value: '0', label: 'closing within 7 days' },
    { value: '12', label: 'solicitations on record' },
  ]);
  assert.deepEqual(classCardStats({ open: 0, closing: 0, onRecord: 0, nsns: 1234, purchases: 5678 }), [
    { value: '1,234', label: 'stock numbers tracked' },
    { value: '5,678', label: 'purchase records' },
  ]);
});

test('the class page, classes.csv and the share card all take their figures from buildClassTotals', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const f of ['../pages/fsc/[fsc]/[...page].astro', './csv-tables.ts', '../pages/og/class-[fsc].png.ts']) {
    assert.ok(read(f).includes('buildClassTotals('), `${f} must use buildClassTotals`);
  }
  assert.ok(!read('./csv-tables.ts').includes('pricePointsByNsn'), 'csv-tables.ts must not sum price points itself');
});
