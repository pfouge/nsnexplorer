import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompetitionRows, buildRepeat, buildStateMap, buildWeekly, buildWinners, fmtAvg, mondayOf, repeatValueLabel, type RepeatRow, type WeekCount,
} from './viz-class.ts';

const cls = (fsc: string, open: number, restricted: number, unknown: number) => ({ fsc, label: `${fsc} X`, open, restricted, unknown });

test('competition mix: focus first, 5 others at most, shares from counts', () => {
  const others = ['5330', '5331', '5310', '5305', '5306', '5307'].map((c, i) => cls(c, 10 - i, 5, 5));
  const rows = buildCompetitionRows(cls('5340', 58, 34, 8), others)!;
  assert.equal(rows.length, 6);
  assert.equal(rows[0].fsc, '5340');
  assert.equal(rows[0].focus, true);
  assert.deepEqual(rows[0].segments.map((s) => s.pct), [58, 34, 8]);
  assert.equal(rows[0].openPct, 58);
  assert.deepEqual(rows.slice(1).map((r) => r.fsc), ['5330', '5331', '5310', '5305', '5306']);
  assert.ok(rows.slice(1).every((r) => !r.focus));
});

test('competition mix: needs one coded NSN in the focus class; empty neighbours and the focus class itself are skipped', () => {
  assert.equal(buildCompetitionRows(cls('5340', 0, 0, 40), [cls('5330', 5, 5, 5)]), null);
  assert.equal(buildCompetitionRows(cls('5340', 1, 0, 0), [])?.length, 1);
  const r = buildCompetitionRows(cls('5340', 1, 0, 0), [cls('5340', 1, 1, 1), cls('5330', 0, 0, 0), cls('5331', 1, 0, 0)])!;
  assert.deepEqual(r.map((x) => x.fsc), ['5340', '5331']);
});

const rr = (nsn: string, solicitations: number, quantity: number): RepeatRow => ({ nsn, name: nsn, solicitations, quantity });

test('re-bought: top 7 each way among items bought at least twice; both panels ranked independently', () => {
  const rows = [rr('a', 14, 100), rr('b', 12, 5000), rr('c', 9, 50), rr('d', 8, 1), rr('e', 7, 1), rr('f', 6, 1), rr('g', 5, 1), rr('h', 4, 99999), rr('i', 1, 1_000_000)];
  const m = buildRepeat(rows, '2025-01-01', '2026-10-05')!;
  assert.deepEqual(m.byCount.map((r) => r.nsn), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(m.byQty.map((r) => r.nsn), ['h', 'b', 'a', 'c', 'd', 'e', 'f']);
  assert.equal(m.note, 'Counts every solicitation recorded for the item in the last 12 months.');
});

test('re-bought: minimum 2 items with 2+ solicitations; tracked-since note under 12 months of history', () => {
  assert.equal(buildRepeat([rr('a', 5, 1), rr('b', 1, 1), rr('c', 1, 1)], null, '2026-10-05'), null);
  assert.equal(buildRepeat([rr('a', 5, 1), rr('b', 2, 1)], null, '2026-10-05')?.byCount.length, 2);
  assert.match(buildRepeat([rr('a', 5, 1), rr('b', 2, 1)], '2026-05-14', '2026-10-05')!.note, / Solicitations have been tracked since May 2026\.$/);
  assert.doesNotMatch(buildRepeat([rr('a', 5, 1), rr('b', 2, 1)], '2025-10-05', '2026-10-05')!.note, /tracked since/);
  assert.equal(repeatValueLabel(rr('a', 1, 1), 'count'), '1 solicitation');
  assert.equal(repeatValueLabel(rr('a', 14, 4200), 'count'), '14 solicitations');
  assert.equal(repeatValueLabel(rr('a', 14, 4200), 'qty'), '4,200 units');
  assert.equal(repeatValueLabel(rr('a', 14, 1), 'qty'), '1 unit');
});

test('mondayOf', () => {
  assert.equal(mondayOf('2026-10-05'), '2026-10-05'); // Monday
  assert.equal(mondayOf('2026-10-04'), '2026-09-28'); // Sunday
  assert.equal(mondayOf('2026-10-07'), '2026-10-05');
});

const weeksOf = (n: number, f: (i: number) => number, lastMonday = '2026-09-28'): WeekCount[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${lastMonday}T00:00:00Z`) - (n - 1 - i) * 7 * 86400000);
    return { week: d.toISOString().slice(0, 10), n: f(i) };
  });

test('weekly: today is Monday Oct 5 2026 so the last complete week starts Sep 28; at most 52 weeks', () => {
  const rows = weeksOf(60, (i) => 10 + i);
  const m = buildWeekly(rows, '2026-10-05', '2024-01-01')!;
  assert.equal(m.weeks.length, 52);
  assert.equal(m.weeks[51].week, '2026-09-28');
  assert.equal(m.weeks[0].week, '2025-10-06');
  assert.equal(m.weeks[51].n, 69);
  assert.doesNotMatch(m.note, /tracked since/);
});

test('weekly: the running week is not drawn', () => {
  const rows = [...weeksOf(20, () => 3), { week: '2026-10-05', n: 99 }];
  const m = buildWeekly(rows, '2026-10-07', '2026-01-01')!;
  assert.equal(m.weeks[m.weeks.length - 1].week, '2026-09-28');
  assert.ok(m.weeks.every((w) => w.n !== 99));
});

test('weekly: starts at the first fully tracked week, zero-fills, 8-week average only from 12 weeks', () => {
  // tracking began Wed Jul 8 2026 -> first full week is Mon Jul 13
  assert.equal(buildWeekly(weeksOf(11, () => 4), '2026-10-05', '2026-09-16'), null); // only Sep 21 and Sep 28 are tracked: below 4 active weeks
  const m = buildWeekly(weeksOf(12, (i) => i + 1), '2026-10-05', '2026-07-08')!;
  assert.equal(m.weeks[0].week, '2026-07-13');
  assert.equal(m.weeks.length, 12);
  assert.ok(m.avg);
  assert.deepEqual(m.avg!.slice(0, 7), new Array(7).fill(null));
  assert.equal(m.avg![7], (1 + 2 + 3 + 4 + 5 + 6 + 7 + 8) / 8);
  assert.match(m.note, /^In the week of Sep 28, 12 solicitations were posted\. The 8-week average is 8\.5\. Solicitations have been tracked since Jul 2026\.$/);
});

test('weekly: under 12 weeks has no average; under 4 active weeks nothing at all', () => {
  const rows = weeksOf(8, () => 5);
  const m = buildWeekly(rows, '2026-10-05', '2026-08-03')!;
  assert.equal(m.avg, null);
  assert.doesNotMatch(m.note, /average/);
  assert.equal(buildWeekly(weeksOf(3, () => 5), '2026-10-05', '2024-01-01'), null);
  assert.equal(buildWeekly(weeksOf(8, (i) => (i < 3 ? 5 : 0)), '2026-10-05', '2024-01-01'), null);
  assert.equal(buildWeekly(weeksOf(4, () => 1), '2026-10-05', '2024-01-01')?.weeks.filter((w) => w.n > 0).length, 4);
});

test('weekly: singular note and month labels without collisions', () => {
  const m = buildWeekly(weeksOf(20, (i) => (i === 19 ? 1 : 2)), '2026-10-05', '2026-05-18')!;
  assert.match(m.note, /^In the week of Sep 28, 1 solicitation was posted\./);
  const labels = m.monthLabels;
  for (let k = 1; k < labels.length; k++) assert.ok(labels[k].i - labels[k - 1].i >= 4);
  assert.ok(labels.every((l) => /^[A-Z][a-z]{2}$/.test(l.label)));
  // 20 weeks ending Sep 28: first bar is the week of May 18 -> label May at 0, then Jun 1 is index 2 (too close): May is dropped
  assert.equal(m.weeks[0].week, '2026-05-18');
  assert.deepEqual(labels.map((l) => l.label), ['Jun', 'Jul', 'Aug', 'Sep']);
});

test('average formatting', () => {
  assert.equal(fmtAvg(148.4), '148');
  assert.equal(fmtAvg(1234.6), '1,235');
  assert.equal(fmtAvg(8.46), '8.5');
  assert.equal(fmtAvg(0.25), '0.3');
});

test('winners: top 6 + other, top-three share, minimum 3 suppliers', () => {
  const top = [4.8, 3.1, 2.2, 1.4, 1.1, 0.9].map((v, i) => ({ label: `S${i}`, amount: v * 1e6 }));
  const r = buildWinners({ top, suppliers: 218, total: 19.8e6 })!;
  assert.equal(r.bars.length, 7);
  assert.equal(r.bars[6].label, 'All other suppliers (212)');
  assert.equal(r.bars[6].other, true);
  assert.equal(Math.round(r.bars[6].amount), 6.3e6);
  assert.equal(r.topThreePct, 51);
  assert.equal(r.bars[0].pct, 24);
  const six = buildWinners({ top, suppliers: 6, total: 13.5e6 })!;
  assert.equal(six.bars.length, 6);
  assert.ok(six.bars.every((b) => !b.other));
  assert.equal(buildWinners({ top: top.slice(0, 2), suppliers: 2, total: 8e6 }), null);
  assert.equal(buildWinners({ top: top.slice(0, 3), suppliers: 3, total: 10e6 })?.bars.length, 3);
});

test('state map: tile states only, others counted as no state, minimum 5 with a state', () => {
  const rows = [
    { state: 'TX', suppliers: 3, amount: 100 }, { state: 'OH', suppliers: 1, amount: 50 }, { state: 'PR', suppliers: 2, amount: 5 },
    { state: null, suppliers: 1, amount: 7 }, { state: 'TX', suppliers: 1, amount: 1 },
  ];
  const m = buildStateMap(rows)!;
  assert.equal(m.withState, 5);
  assert.equal(m.missing, 3);
  assert.deepEqual(m.byState.get('TX'), { suppliers: 4, amount: 101 });
  assert.equal(m.max, 4);
  assert.equal(m.note, 'From supplier addresses in the federal CAGE file. 3 suppliers have no U.S. state on file.');
  assert.equal(buildStateMap(rows.slice(0, 2)), null);
  assert.equal(buildStateMap([{ state: 'TX', suppliers: 5, amount: 1 }])!.note, 'From supplier addresses in the federal CAGE file.');
  assert.match(buildStateMap([{ state: 'TX', suppliers: 5, amount: 1 }, { state: null, suppliers: 1, amount: 0 }])!.note, /1 supplier has no U\.S\. state/);
});
