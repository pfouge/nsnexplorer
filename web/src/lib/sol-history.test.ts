import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSummary, repeatWinner, valueAtLastPrice, winners, type HistoryPoint } from './sol-history.ts';

const pt = (awardedOn: string, unitPrice: number, cage: string | null, supplierName: string | null = cage ? `Supplier ${cage}` : null): HistoryPoint => ({
  awardedOn,
  unitPrice,
  cage,
  supplierName,
});

test('empty input', () => {
  assert.equal(priceSummary([]), null);
  assert.deepEqual(winners([]), []);
  assert.equal(repeatWinner([]), null);
});

test('priceSummary uses the five most recent positive prices', () => {
  const points = [
    pt('2024-01-01', 1000, 'AAAAA'), // outside the window
    pt('2024-06-01', 10, 'AAAAA'),
    pt('2024-05-01', 20, 'AAAAA'),
    pt('2024-04-01', 0, 'AAAAA'), // not positive: skipped
    pt('2024-03-01', 30, 'AAAAA'),
    pt('2024-02-15', 40, 'AAAAA'),
    pt('2024-02-01', 50.555, 'AAAAA'),
  ];
  const s = priceSummary(points)!;
  assert.equal(s.n, 5);
  assert.equal(s.latest, 10);
  assert.equal(s.low, 10);
  assert.equal(s.high, 50.555);
  assert.equal(s.average, 30.11); // (10+20+30+40+50.555)/5 = 30.111
  assert.equal(priceSummary([pt('2024-01-01', 0, null), pt('2024-01-02', -3, null)]), null);
});

test('priceSummary with ties on date keeps input order for latest', () => {
  const s = priceSummary([pt('2024-01-01', 5, 'AAAAA'), pt('2024-01-01', 7, 'BBBBB')])!;
  assert.equal(s.latest, 5);
  assert.equal(s.n, 2);
});

test('winners group by cage, ignore null cages, sort wins then recency', () => {
  const rows = winners([
    pt('2024-01-01', 1, 'AAAAA'),
    pt('2024-03-01', 2, 'BBBBB'),
    pt('2024-02-01', 3, null),
    pt('2024-04-01', 4, 'AAAAA'),
    pt('2024-05-01', 5, 'CCCCC'),
    pt('2024-05-01', 6, '  '),
  ]);
  assert.deepEqual(rows.map((r) => [r.cage, r.wins, r.lastWon, r.lastPrice]), [
    ['AAAAA', 2, '2024-04-01', 4],
    ['CCCCC', 1, '2024-05-01', 5],
    ['BBBBB', 1, '2024-03-01', 2],
  ]);
  assert.equal(rows[0].supplierName, 'Supplier AAAAA');
});

test('winners: tie on wins and date is stable', () => {
  const rows = winners([pt('2024-01-01', 1, 'AAAAA'), pt('2024-01-01', 2, 'BBBBB')]);
  assert.deepEqual(rows.map((r) => r.cage), ['AAAAA', 'BBBBB']);
});

test('repeatWinner: exactly 3', () => {
  const r = repeatWinner([pt('2024-01-01', 1, 'AAAAA'), pt('2024-02-01', 1, 'AAAAA'), pt('2024-03-01', 1, 'AAAAA')]);
  assert.deepEqual(r, { cage: 'AAAAA', supplierName: 'Supplier AAAAA', streak: 3 });
});

test('repeatWinner: streak broken at 2 is null', () => {
  assert.equal(
    repeatWinner([pt('2024-04-01', 1, 'AAAAA'), pt('2024-03-01', 1, 'AAAAA'), pt('2024-02-01', 1, 'BBBBB'), pt('2024-01-01', 1, 'AAAAA')]),
    null
  );
});

test('repeatWinner: null cages are skipped, longer runs counted, fewer than 3 with a cage is null', () => {
  const six = ['06', '05', '04', '03', '02'].map((m) => pt(`2024-${m}-01`, 1, 'AAAAA'));
  six.splice(1, 0, pt('2024-05-15', 1, null));
  six.push(pt('2024-01-01', 1, 'BBBBB'));
  assert.equal(repeatWinner(six)!.streak, 5);
  assert.equal(repeatWinner([pt('2024-02-01', 1, 'AAAAA'), pt('2024-01-01', 1, 'AAAAA'), pt('2023-12-01', 1, null)]), null);
});

test('more than five points: only the latest run matters', () => {
  const points = Array.from({ length: 8 }, (_, i) => pt(`2024-0${8 - i}-01`, 10 + i, 'AAAAA'));
  assert.equal(repeatWinner(points)!.streak, 8);
  assert.equal(priceSummary(points)!.n, 5);
  assert.equal(winners(points)[0].wins, 8);
});

test('valueAtLastPrice', () => {
  assert.equal(valueAtLastPrice(3, 1.25), 3.75);
  assert.equal(valueAtLastPrice(10, 2.5), 25);
  assert.equal(valueAtLastPrice(0, 2), null);
  assert.equal(valueAtLastPrice(5, 0), null);
  assert.equal(valueAtLastPrice(null, 2), null);
  assert.equal(valueAtLastPrice(5, null), null);
});
