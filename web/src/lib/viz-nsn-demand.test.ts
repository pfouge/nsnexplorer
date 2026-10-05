import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AwardIn, SolIn } from './viz-nsn-common.ts';
import { buildBuyingRhythm, cadence, groupBuys } from './viz-nsn-rhythm.ts';
import { buildTimeToAward, timingRows } from './viz-nsn-timing.ts';
import { buildWinners, awardsLabel } from './viz-nsn-winners.ts';

const TODAY = '2026-10-04';
let seq = 0;
const aw = (awardedOn: string, unitPrice: number, quantity: number | null = 100, extra: Partial<AwardIn> = {}): AwardIn => ({
  id: ++seq, awardedOn, unitPrice, quantity, cage: '1ABC2', supplierName: 'ACME', sourceUrl: 'https://x/aw/' + seq, solNumber: null, spikeRatio: null, ...extra,
});
const sol = (solNumber: string, issuedOn: string | null, returnBy: string | null, quantity: number | null, status = 'expired'): SolIn => ({ solNumber, issuedOn, returnBy, quantity, status });
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test('chart 15: buys chain within 14 days; cadence; below two buys renders nothing', () => {
  const sols = [sol('A', '2025-01-01', null, 10), sol('B', '2025-01-12', null, 5), sol('C', '2025-01-25', null, null), sol('D', '2025-05-01', null, 20), sol('E', '2025-09-01', null, 30), sol('N', null, null, 5)];
  const buys = groupBuys(sols);
  assert.deepEqual(buys.map((b) => [b.first, b.qty, b.solNumbers.length]), [['2025-01-01', 15, 3], ['2025-05-01', 20, 1], ['2025-09-01', 30, 1]]);
  assert.equal(buildBuyingRhythm([sol('A', '2025-01-01', null, 10)], [], TODAY), null);
  assert.equal(buildBuyingRhythm([sol('A', '2025-01-01', null, 10), sol('B', '2025-01-05', null, 10)], [], TODAY), null);
  const c = cadence(buys, sols, TODAY);
  assert.equal(c.buys, 3);
  assert.equal(c.unit, 'month');
  assert.equal(c.daysSinceLast, 398);
  const m = buildBuyingRhythm(sols, [{ date: '2025-02-20', quantity: 15, supplier: 'ACME', solNumber: 'A' }, { date: '2025-06-10', quantity: null, supplier: null, solNumber: null }], TODAY)!;
  assert.match(m.headline, /^Solicited 3 times since Jan 2025, typically every \d\.\d months\.$/);
  assert.equal(m.lastLine, 'Last solicitation 398 days ago.');
  assert.equal(count(m.svg, /vs-alt/g), 3);
  assert.equal(count(m.svg, /vf-main vring/g), 2);
  assert.equal(count(m.svg, /<line [^>]*stroke-opacity/g), 1);
  assert.deepEqual(m.legend.map((l) => l.label), ['Solicitation posted', 'Award made']);
  const weekly = cadence(groupBuys([sol('A', '2026-01-01', null, 1), sol('B', '2026-02-01', null, 1), sol('C', '2026-03-05', null, 1)]), [], TODAY);
  assert.equal(weekly.unit, 'week');
  assert.equal(buildBuyingRhythm([sol('A', '2026-01-01', null, 1), sol('B', '2026-02-01', null, 1), sol('C', '2026-03-05', null, 1)], [], TODAY)!.legend.length, 1);
});

test('chart 15: radius is capped', () => {
  const m = buildBuyingRhythm([sol('A', '2025-01-01', null, 1e9), sol('B', '2025-06-01', null, 4)], [], TODAY)!;
  assert.match(m.svg, /r="14"/);
});

test('chart 16: segments, matching rules, median and caption', () => {
  const sols = [
    sol('S1', '2026-01-01', '2026-01-15', 10), sol('S2', '2026-03-01', '2026-03-20', 10), sol('S3', '2026-05-01', null, 10),
    sol('S4', '2026-07-01', '2026-07-30', 10), sol('NOISS', null, '2026-02-01', 10),
  ];
  const awards = [
    { awardedOn: '2026-02-20', solNumber: 'S1' }, // open 14, closed 36
    { awardedOn: '2026-03-10', solNumber: 'S2' }, // awarded before the deadline: open 9, closed 0
    { awardedOn: '2026-06-01', solNumber: 'S3' }, // no return date: open 31, closed 0
    { awardedOn: '2026-06-01', solNumber: 'S3' }, // duplicate (same solicitation and date)
    { awardedOn: '2026-02-01', solNumber: 'NOISS' },
    { awardedOn: '2026-06-30', solNumber: 'S4' }, // award before issue: skipped
    { awardedOn: '2026-08-01', solNumber: 'GHOST' },
  ];
  const rows = timingRows(awards, sols);
  assert.deepEqual(rows.map((r) => [r.open, r.closed, r.total]), [[31, 0, 31], [9, 0, 9], [14, 36, 50]]);
  const m = buildTimeToAward(awards, sols)!;
  assert.equal(m.medianDays, 31);
  assert.equal(m.note, 'The typical buy took 31 days from posting to award.');
  assert.match(m.svg, /50 days/);
  assert.equal(buildTimeToAward(awards.slice(0, 1), sols), null);
  const late = [sol('L1', '2026-01-01', '2026-01-10', 1), sol('L2', '2026-03-01', '2026-03-10', 1)];
  const m2 = buildTimeToAward([{ awardedOn: '2026-02-20', solNumber: 'L1' }, { awardedOn: '2026-04-20', solNumber: 'L2' }], late)!;
  assert.match(m2.note, / Most of that came after quotes closed\.$/);
  const many = Array.from({ length: 12 }, (_, i) => sol(`M${i}`, `2025-${String(i + 1).padStart(2, '0')}-01`, `2025-${String(i + 1).padStart(2, '0')}-10`, 1));
  assert.equal(timingRows(many.map((s, i) => ({ awardedOn: `2025-${String(i + 1).padStart(2, '0')}-28`, solNumber: s.solNumber })), many).length, 8);
});

test('chart 17: rows, ordering, dots and caption', () => {
  const awards = [
    { date: '2026-08-01', cage: 'AAAAA', name: 'ALPHA' }, { date: '2026-06-01', cage: 'AAAAA', name: 'ALPHA' }, { date: '2026-05-01', cage: 'BBBBB', name: 'BRAVO <&>' },
    { date: '2022-01-01', cage: 'BBBBB', name: 'BRAVO <&>' }, { date: '2024-01-01', cage: 'CCCCC', name: null },
  ];
  const sources = [{ cage: 'AAAAA', name: 'ALPHA' }, { cage: 'BBBBB', name: 'BRAVO <&>' }, { cage: 'ZZZZZ', name: null }, { cage: 'DDDDD', name: 'DELTA' }];
  const m = buildWinners(awards, sources, TODAY)!;
  assert.deepEqual(m.rows.map((r) => r.cage), ['AAAAA', 'BBBBB', 'CCCCC', 'ZZZZZ', 'DDDDD']);
  assert.deepEqual(m.rows.map((r) => r.listed), [true, true, false, true, true]);
  assert.equal(m.rows[1].ariaLabel, '1 recent and 1 older awards');
  assert.equal(m.rows[2].name, 'CAGE CCCCC');
  assert.equal(m.rows[3].name, 'CAGE ZZZZZ');
  assert.equal(m.note, 'ALPHA won 2 of the last 5 awards. CAGE CCCCC won without being a listed source.');
  assert.equal(buildWinners([], sources, TODAY), null);
  assert.equal(awardsLabel(0, 0), 'no awards on record');
  const none = buildWinners(awards, [], TODAY)!;
  assert.equal(none.haveSources, false);
  assert.ok(!none.note.includes('listed source'));
  assert.equal(buildWinners([{ date: '2026-08-01', cage: 'AAAAA', name: 'ALPHA' }], [], TODAY)!.note, 'ALPHA won the only award on record.');
});

test('chart 17: 12 dots then +N, 8 rows maximum, recent dots first', () => {
  const awards = Array.from({ length: 20 }, (_, i) => ({ date: i < 5 ? `2026-0${i + 1}-01` : `2020-${String((i % 12) + 1).padStart(2, '0')}-01`, cage: 'AAAAA', name: 'A' }));
  const r = buildWinners(awards, [], TODAY)!.rows[0];
  assert.deepEqual([r.dotsRecent, r.dotsOld, r.more], [5, 7, 8]);
  assert.equal(r.ariaLabel, '5 recent and 15 older awards');
  const sources = Array.from({ length: 12 }, (_, i) => ({ cage: `S${String(i).padStart(4, '0')}`, name: `SRC ${i}` }));
  assert.equal(buildWinners(awards, sources, TODAY)!.rows.length, 8);
});
