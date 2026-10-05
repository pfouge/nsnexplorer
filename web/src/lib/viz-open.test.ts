import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, buildBidMarks, buildCalendar, countAxis, foldCalendarRows, powerAbove, whenLabel, type BidSolicitation } from './viz-open.ts';

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('calendar: 30 bars from today, first 7 are warn, minimum 5 closing', () => {
  const counts = new Array(30).fill(0);
  counts[0] = 2; counts[6] = 1; counts[7] = 2;
  const c = buildCalendar(counts, '2026-10-05')!;
  assert.equal(c.bars.length, 30);
  assert.equal(c.bars[0].date, '2026-10-05');
  assert.equal(c.bars[29].date, '2026-11-03');
  assert.equal(c.bars.filter((b) => b.warn).length, 7);
  assert.equal(c.total, 5);
  assert.equal(c.max, 2);
  counts[7] = 1;
  assert.equal(buildCalendar(counts, '2026-10-05'), null);
  assert.equal(buildCalendar([], '2026-10-05'), null);
});

test('calendar rows from SQL fold into slots and ignore out-of-window days', () => {
  const f = foldCalendarRows([{ d: 0, n: 3 }, { d: 29, n: 4 }, { d: 30, n: 9 }, { d: -1, n: 9 }, { d: 0, n: 1 }]);
  assert.equal(f.length, 30);
  assert.equal(f[0], 4);
  assert.equal(f[29], 4);
  assert.equal(f.reduce((a, b) => a + b, 0), 8);
});

test('when labels', () => {
  assert.deepEqual([0, 1, 2, 29].map(whenLabel), ['Today', 'In 1 day', 'In 2 days', 'In 29 days']);
});

const sol = (n: string, quantity: number | null, returnBy: string | null, competition: BidSolicitation['competition'] = 'open'): BidSolicitation => ({
  solNumber: n, nsn: '5340-00-000-0001', name: 'Clip', quantity, returnBy, competition,
});

test('bid marks: quantity above zero, return_by within 0..30 days, soonest first', () => {
  const sols = [
    sol('a', 10, '2026-10-05'), sol('b', 0, '2026-10-06'), sol('c', null, '2026-10-06'), sol('d', 5, null), sol('e', 5, '2026-11-04'),
    sol('f', 5, '2026-11-05'), sol('g', 7, '2026-10-04'), sol('h', 9, '2026-10-10'), sol('i', 1, '2026-10-10'), sol('j', 100, '2026-10-20'),
  ];
  const r = buildBidMarks(sols, '2026-10-05')!;
  assert.deepEqual(r.marks.map((m) => m.solNumber), ['a', 'h', 'i', 'j', 'e']);
  assert.deepEqual(r.marks.map((m) => m.days), [0, 5, 5, 15, 30]);
  assert.equal(r.total, 5);
  assert.equal(r.capped, false);
});

test('bid marks: below 5 nothing; more than 400 keeps the 400 soonest and reports the total', () => {
  assert.equal(buildBidMarks([sol('a', 1, '2026-10-06'), sol('b', 1, '2026-10-06')], '2026-10-05'), null);
  const many = Array.from({ length: 450 }, (_, i) => sol(`s${String(i).padStart(3, '0')}`, 1 + i, `2026-10-${String(5 + (i % 25)).padStart(2, '0')}`));
  const r = buildBidMarks(many, '2026-10-05')!;
  assert.equal(r.marks.length, 400);
  assert.equal(r.total, 450);
  assert.equal(r.capped, true);
  const maxDays = Math.max(...r.marks.map((m) => m.days));
  const dropped = many.filter((s) => !r.marks.some((m) => m.solNumber === s.solNumber));
  assert.ok(dropped.every((s) => (Date.parse(s.returnBy!) - Date.parse('2026-10-05')) / 86400000 >= maxDays));
});

test('power of ten above the max (strictly)', () => {
  assert.equal(powerAbove(1), 10);
  assert.equal(powerAbove(9), 10);
  assert.equal(powerAbove(10), 100);
  assert.equal(powerAbove(999), 1000);
  assert.equal(powerAbove(1000), 10000);
  assert.equal(powerAbove(84000), 100000);
});

test('count axis: round whole-number ticks from ticks()', () => {
  const t = (max: number) => countAxis(max);
  assert.deepEqual(t(250), { top: 250, ticks: [50, 100, 150, 200, 250] });
  assert.deepEqual(t(238).ticks, [50, 100, 150, 200, 250]);
  assert.deepEqual(t(1258), { top: 2000, ticks: [500, 1000, 1500, 2000] });
  assert.deepEqual(t(100).ticks, [25, 50, 75, 100]);
  assert.deepEqual(t(2.3), { top: 5, ticks: [1, 2, 3, 4, 5] });
  assert.deepEqual(t(2).ticks, [1, 2]);
  assert.deepEqual(t(1).ticks, [1]);
  for (const max of [1, 2, 3, 7, 9, 12, 33, 60, 99, 101, 450, 777, 4300, 12000]) {
    const { top, ticks } = t(max);
    assert.ok(top >= max);
    assert.equal(ticks[ticks.length - 1], top);
    assert.ok(ticks.every((v) => Number.isInteger(v)), `integers for ${max}: ${ticks}`);
  }
});
