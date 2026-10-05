import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisFor, dateTicks, fmtAxisPrice, money, timeDomain, type AwardIn, type SolIn } from './viz-nsn-common.ts';
import { buildPriceHistory, dotRadius } from './viz-nsn-price.ts';
import { bandOf, buildPriceByQty, clipLine, logTicks, nearAwards, qtyEligible, soonestOpen, trendFit } from './viz-nsn-qty.ts';
import { calcOptions, calcRows, calcStats, rangeBarSvg, windowLabel } from './viz-nsn-calc.ts';

const TODAY = '2026-10-04';
let seq = 0;
const aw = (awardedOn: string, unitPrice: number, quantity: number | null = 100, extra: Partial<AwardIn> = {}): AwardIn => ({
  id: ++seq, awardedOn, unitPrice, quantity, cage: '1ABC2', supplierName: 'ACME', sourceUrl: 'https://x/aw/' + seq, solNumber: null, spikeRatio: null, ...extra,
});
const sol = (solNumber: string, issuedOn: string | null, returnBy: string | null, quantity: number | null, status = 'expired'): SolIn => ({ solNumber, issuedOn, returnBy, quantity, status });
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test('axis: round tick values for every niceMax mantissa', () => {
  assert.deepEqual(axisFor(0.9).values, [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(axisFor(1.7).values, [0.5, 1, 1.5, 2]);
  assert.deepEqual(axisFor(2.3).values, [0.5, 1, 1.5, 2, 2.5]);
  assert.deepEqual(axisFor(4.1).values, [1, 2, 3, 4, 5]);
  assert.equal(fmtAxisPrice(0.25, 0.25), '$0.25');
  assert.equal(fmtAxisPrice(2500, 500), '$2,500');
});

test('money keeps sub-dime prices readable', () => {
  assert.equal(money(3.456), '$3.46');
  assert.equal(money(0.0087), '$0.0087');
  assert.equal(money(0.05), '$0.05');
  assert.equal(money(1234.5), '$1,235');
});

test('time domain is at least 12 months; ticks are Januaries, or quarters under 18 months', () => {
  const d = timeDomain('2026-08-01', '2026-09-01', TODAY);
  assert.ok(d.t1 - d.t0 >= 365 * 86400000);
  const q = dateTicks(d.t0, d.t1).map((t) => t.label);
  assert.deepEqual(q, ['Jan 2026', 'Apr 2026', 'Jul 2026', 'Oct 2026'].filter((l) => q.includes(l)));
  assert.ok(q.includes('Apr 2026'));
  const wide = timeDomain('2021-10-01', '2026-09-01', TODAY);
  assert.deepEqual(dateTicks(wide.t0, wide.t1).map((t) => t.label), ['Jan 2022', 'Jan 2023', 'Jan 2024', 'Jan 2025', 'Jan 2026']);
});

test('chart 12: below minimum renders nothing; dots, band and flagged labels', () => {
  assert.equal(buildPriceHistory([], TODAY), null);
  assert.equal(buildPriceHistory([aw('2026-01-01', 2), aw('2026-02-01', 3)], TODAY), null);
  const pts = [2, 3, 3, 4, 3, 3.5, 2.8, 3.2].map((p, i) => aw(`2025-0${i + 1}-15`, p, [10, 100, 1000, 5000, null, 50, 250, 25][i]));
  pts.push(aw('2026-03-01', 15, 100, { spikeRatio: 4.6 }), aw('2026-04-01', 16, 100, { spikeRatio: 5.1 }));
  const m = buildPriceHistory(pts, TODAY)!;
  assert.equal(count(m.svg, /<a /g), 10);
  assert.equal(count(m.svg, /vf-flag/g), 2);
  assert.equal(m.flagged, 2);
  assert.equal(count(m.svg, /× median</g), 2);
  assert.match(m.svg, /target="_blank" rel="nofollow noopener"/);
  assert.match(m.svg, /median \$[\d.]+, middle half shaded/);
  assert.match(m.note, /^Most awards fall between \$[\d.,]+ and \$[\d.,]+\. 2 awards ran well above that range and are marked\.$/);
  assert.deepEqual(m.legend.map((l) => l.key), ['main', 'flag', 'band']);
  assert.ok(m.q1 <= m.median && m.median <= m.q3);
});

test('chart 12: no flagged award means no flag legend or sentence; labels capped at 3', () => {
  const pts = [2, 3, 3.1].map((p, i) => aw(`2025-0${i + 1}-10`, p));
  const m = buildPriceHistory(pts, TODAY)!;
  assert.deepEqual(m.legend.map((l) => l.key), ['main', 'band']);
  assert.ok(!m.note.includes('ran well above'));
  const many = [...pts, ...[1, 2, 3, 4].map((i) => aw(`2026-0${i}-10`, 20 + i, 10, { spikeRatio: 3 + i }))];
  const m2 = buildPriceHistory(many, TODAY)!;
  assert.equal(count(m2.svg, /× median</g), 3);
  assert.match(m2.note, /4 awards ran well above/);
  assert.match(buildPriceHistory([...pts, aw('2026-01-01', 30, 10, { spikeRatio: 9 })], TODAY)!.note, / 1 award ran well above that range and is marked\.$/);
});

test('chart 12: supplier text is escaped, hostile links are not linked, radius follows log quantity', () => {
  const pts = [aw('2025-01-01', 2, 100, { supplierName: '<script>alert(1)</script> & "Co"', sourceUrl: 'javascript:alert(1)' }), aw('2025-02-01', 3), aw('2025-03-01', 4)];
  const m = buildPriceHistory(pts, TODAY)!;
  assert.ok(!m.svg.includes('<script>'));
  assert.ok(!m.svg.includes('javascript:'));
  assert.match(m.svg, /&lt;script&gt;/);
  assert.equal(count(m.svg, /<a /g), 2);
  assert.equal(dotRadius(null), 3.5);
  assert.ok(Math.abs(dotRadius(1000) - 10.7) < 1e-9);
});

test('chart 13: eligibility needs 5 quantity points and 3 distinct quantities', () => {
  const same = Array.from({ length: 6 }, (_, i) => aw(`2025-0${i + 1}-01`, 2 + i / 10, 100));
  assert.equal(qtyEligible(same), false);
  assert.equal(buildPriceByQty(same, []), null);
  const two = [10, 10, 10, 20, 20, 20].map((q, i) => aw(`2025-0${i + 1}-01`, 2, q));
  assert.equal(qtyEligible(two), false);
  const ok = [10, 20, 40, 80, 160].map((q, i) => aw(`2025-0${i + 1}-01`, 2, q));
  assert.equal(qtyEligible(ok), true);
  assert.equal(qtyEligible([...ok.slice(0, 3), aw('2025-09-01', 3, null), aw('2025-10-01', 3, null)]), false);
});

test('chart 13: trend only from 8 points, least squares on log10(quantity)', () => {
  const pts = [10, 20, 40, 80, 160, 320, 640, 1280].map((q, i) => aw(`2025-0${i + 1}-01`, 5 - 0.5 * Math.log10(q), q));
  const f = trendFit(pts)!;
  assert.ok(Math.abs(f.slope + 0.5) < 1e-9 && Math.abs(f.intercept - 5) < 1e-9);
  assert.equal(trendFit(pts.slice(0, 7)), null);
  assert.equal(buildPriceByQty(pts, [])!.hasTrend, true);
  assert.equal(buildPriceByQty(pts.slice(0, 7), [])!.hasTrend, false);
});

test('chart 13: soonest open solicitation with a quantity, band and near awards', () => {
  const sols = [sol('A', '2026-09-01', '2026-11-01', 500, 'open'), sol('B', '2026-09-02', '2026-10-20', 250, 'open'), sol('C', '2026-09-03', '2026-10-10', null, 'open'), sol('D', '2026-01-01', '2026-02-01', 90, 'expired')];
  assert.equal(soonestOpen(sols)!.solNumber, 'B');
  assert.equal(soonestOpen([sol('D', null, null, 90, 'expired')]), null);
  const { lo, hi } = bandOf(250);
  assert.ok(Math.abs(lo - 138.888) < 0.01 && Math.abs(hi - 450) < 1e-9);
  const pts = [100, 140, 250, 450, 460, 1000, 30].map((q, i) => aw(`2025-0${i + 1}-01`, 2 + i * 0.5, q));
  assert.deepEqual(nearAwards(pts, 250).map((p) => p.quantity), [450, 250, 140]);
  const m = buildPriceByQty(pts, sols)!;
  assert.equal(m.openQty, 250);
  assert.equal(m.nearCount, 3);
  assert.match(m.svg, /open solicitation: qty 250/);
  assert.match(m.note, /^3 past awards were between 139 and 450 units, at \$2\.50 to \$3\.50 each\.$/);
  assert.equal(buildPriceByQty(pts, [])!.note, 'No solicitation is open for this item right now.');
  assert.equal(buildPriceByQty(pts, [sol('X', '2026-09-01', '2026-11-01', 99000, 'open')])!.note, 'No past award was near 99,000 units.');
  assert.equal(buildPriceByQty(pts, [sol('X', '2026-09-01', '2026-11-01', 99000, 'open')])!.near.length, 0);
});

test('chart 13: ticks and line clipping', () => {
  assert.deepEqual(logTicks(8, 6500), [10, 50, 100, 500, 1000, 5000]);
  assert.deepEqual(logTicks(8, 90), [10, 20, 50]);
  assert.ok(logTicks(1, 1e7).length <= 7);
  assert.deepEqual(clipLine(0, 1, () => 5, 10), [0, 5, 1, 5]);
  assert.equal(clipLine(0, 1, () => 50, 10), null);
  const seg = clipLine(0, 1, (x) => -2 + 14 * x, 10)!;
  assert.ok(Math.abs(seg[1]) < 1e-9 && Math.abs(seg[3] - 10) < 1e-9);
});

test('chart 14: rows, options, statistics', () => {
  const pts = Array.from({ length: 15 }, (_, i) => aw(`2026-${String((i % 9) + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, 10 + i, i % 4 === 0 ? null : 10 * (i + 1)));
  const rows = calcRows(pts);
  assert.equal(rows.length, 12);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].date >= r.date));
  assert.deepEqual(calcOptions(12).map((o) => o.label), ['Last 3', 'Last 5', 'Last 10', 'All 12']);
  assert.deepEqual(calcOptions(7).map((o) => o.label), ['Last 3', 'Last 5', 'All 7']);
  assert.deepEqual(calcOptions(5).map((o) => o.label), ['Last 3', 'All 5']);
  assert.deepEqual(calcOptions(3).map((o) => o.label), ['All 3']);
  const r3 = [{ date: '2026-09-01', price: 2, qty: 100, supplier: null }, { date: '2026-06-01', price: 4, qty: 300, supplier: null }, { date: '2026-02-01', price: 9, qty: null, supplier: null }];
  const s = calcStats(r3, 3);
  assert.equal(s.avg, 5);
  assert.equal(s.weighted, (2 * 100 + 4 * 300) / 400);
  assert.equal(s.min, 2);
  assert.equal(s.max, 9);
  assert.equal(windowLabel(s.from, s.to), 'Feb 2026 – Sep 2026');
  assert.equal(windowLabel('2026-09-01', '2026-09-20'), 'Sep 2026');
  assert.equal(calcStats([{ date: '2026-09-01', price: 2, qty: null, supplier: null }], 1).weighted, null);
  assert.match(rangeBarSvg(r3, 2), /weighted average/);
  assert.equal(count(rangeBarSvg(r3, 2), /vf-card vs-main/g), 2);
  assert.match(rangeBarSvg(r3.map((r) => ({ ...r, qty: null })), 2), />average</);
});
