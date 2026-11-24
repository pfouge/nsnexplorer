import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openByClass } from './open-by-class.ts';

const sol = (n: string, closes: string | null, qty: number | null) => ({ solNumber: n, nsn: null, fsc: '5310', nomenclature: 'NUT', itemName: null, quantity: qty, unitOfIssue: 'EA', issuedOn: null, returnBy: closes, status: 'open', setaside: null, buyerOffice: null, techDocs: null, awardFound: false, source: 'dibbs', sourceUrl: 'x' });

test('summarises a class, soonest first, nulls last', () => {
  const m = new Map([['5310', { fsc: '5310', name: 'Nuts', solicitations: [sol('B', null, 2), sol('A', '2026-12-02', 5), sol('C', '2026-12-01', null)] }]]);
  const [c] = openByClass(m, 2);
  assert.equal(c.count, 3);
  assert.equal(c.qty, 7);
  assert.equal(c.nextClose, '2026-12-01');
  assert.deepEqual(c.items.map((i) => i.sol), ['C', 'A']);
});
test('drops service codes and empty classes, sorts by count', () => {
  const m = new Map([
    ['R425', { fsc: 'R425', name: null, solicitations: [sol('S', null, 1)] }],
    ['5305', { fsc: '5305', name: null, solicitations: [] }],
    ['5310', { fsc: '5310', name: null, solicitations: [sol('A', null, 1)] }],
    ['5330', { fsc: '5330', name: null, solicitations: [sol('A', null, 1), sol('B', null, 1)] }],
  ]);
  assert.deepEqual(openByClass(m).map((c) => c.fsc), ['5330', '5310']);
});
