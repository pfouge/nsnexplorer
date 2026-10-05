import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemandTiles, buildTiles, freshnessView, labelFits, layoutDemandTiles, sparkPath, tapeItems, tapeStatus, tileLabels, trendSeries, weekDelta,
  type DailyStatRow, type TapeItem,
} from './viz-site.ts';

const row = (day: string, open: number, awards7 = 0): DailyStatRow => ({ day, open, posted: open / 10, closing7: open / 5, awards7 });
const days = (n: number, end = '2026-10-04') => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(`${end}T00:00:00Z`) - (n - 1 - i) * 86400000).toISOString().slice(0, 10);
  return row(d, 1000 + i * 10, 1_000_000 + i * 100_000);
});

test('tape status: closing within 3 days is "soon", today reads "closes today", past is dropped', () => {
  const t = (issuedOn: string | null, returnBy: string | null) => tapeStatus({ issuedOn, returnBy }, '2026-10-05');
  assert.deepEqual(t('2026-10-03', '2026-10-05'), { cls: 'soon', text: 'closes today' });
  assert.deepEqual(t('2026-10-03', '2026-10-08'), { cls: 'soon', text: 'closes in 3d' });
  assert.deepEqual(t('2026-10-03', '2026-10-09'), { cls: 'new', text: 'posted Oct 3' });
  assert.deepEqual(t('2026-10-03', null), { cls: 'new', text: 'posted Oct 3' });
  assert.equal(t('2026-10-03', '2026-10-04'), null);
  assert.deepEqual(t(null, null), { cls: 'new', text: 'open now' });
});

test('tape items: needs 6 live items after dropping closed ones', () => {
  const item = (returnBy: string | null): TapeItem => ({ fsc: '5340', name: 'Clip', quantity: 5, issuedOn: '2026-10-03', returnBy, source: 'dibbs_rfq', nsn: '5340-00-000-0001' });
  const six = Array.from({ length: 6 }, () => item('2026-10-20'));
  assert.equal(tapeItems(six, '2026-10-05')?.length, 6);
  assert.equal(tapeItems([...six.slice(0, 5), item('2026-10-01')], '2026-10-05'), null);
  assert.equal(tapeItems([...six, item('2026-10-01')], '2026-10-05')?.length, 6);
});

test('trend: needs 7 rows, uses at most the last 90', () => {
  assert.equal(trendSeries(days(6), 'open'), null);
  assert.equal(trendSeries(days(7), 'open')?.values.length, 7);
  const t = trendSeries(days(120), 'open')!;
  assert.equal(t.values.length, 90);
  assert.equal(t.days[89], '2026-10-04');
  assert.equal(t.values[89], 1000 + 119 * 10);
});

test('week delta: up, down, flat, and missing', () => {
  const rows = days(10);
  assert.equal(weekDelta(rows, 'open')?.text, '▲ 70 vs a week earlier');
  assert.equal(weekDelta(rows, 'open')?.dir, 'up');
  const falling = rows.map((r, i) => ({ ...r, open: 5000 - i * 10 }));
  assert.equal(weekDelta(falling, 'open')?.text, '▼ 70 vs a week earlier');
  const flat = rows.map((r) => ({ ...r, open: 5 }));
  assert.deepEqual(weekDelta(flat, 'open'), { dir: 'flat', text: 'no change vs a week earlier' });
  const gap = rows.filter((r) => r.day !== '2026-09-27');
  assert.equal(weekDelta(gap, 'open'), null);
  assert.equal(weekDelta([], 'open'), null);
  assert.equal(weekDelta(rows, 'awards7', (n) => `$${n}`)?.text, '▲ $700000 vs a week earlier');
});

test('tiles: no sparkline or delta below 7 rows, both with 10', () => {
  const live = { open: 2433, posted: 12, postedOn: '2026-10-05', closing7: 400, awards7: 1_234_567 };
  const few = buildTiles(live, days(6));
  assert.ok(few.every((t) => t.spark === null && t.delta === null));
  assert.deepEqual(few.map((t) => t.value), ['2,433', '12', '400', '$1.2M']);
  assert.equal(few[1].label, 'Posted in the last 7 days');
  const ten = buildTiles(live, days(10));
  assert.ok(ten.every((t) => t.spark !== null && t.delta !== null));
  assert.match(ten[0].spark!.aria, /last 10 days: 1,000 on Sep 25, 1,090 on Oct 4/);
});

test('sparkline: scales between min and max, flat series sits mid-height, end dot is the last point', () => {
  const s = sparkPath([1, 2, 3], 200, 36, 4, 5)!;
  assert.equal(s.line, 'M4,31L100,18L196,5');
  assert.deepEqual(s.last, { x: 196, y: 5 });
  assert.ok(s.area.endsWith('L196,36L4,36Z'));
  assert.equal(sparkPath([7, 7, 7])!.last.y, 18);
  assert.equal(sparkPath([7]), null);
});

test('freshness view: hours, yesterday, days; meter against the limit; late flag', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const v = (iso: string, limit: number) => freshnessView(iso, limit, now)!;
  assert.equal(v('2026-10-05T11:30:00Z', 48).age, 'updated less than an hour ago');
  assert.equal(v('2026-10-05T11:00:00Z', 48).age, 'updated 1 hour ago');
  assert.equal(v('2026-10-05T07:00:00Z', 48).age, 'updated 5 hours ago');
  assert.equal(v('2026-10-04T05:00:00Z', 48).age, 'updated yesterday');
  assert.equal(v('2026-09-26T12:00:00Z', 336).age, 'updated 9 days ago');
  assert.equal(v('2026-10-05T00:00:00Z', 48).widthPct, 25);
  assert.equal(v('2026-10-05T00:00:00Z', 48).late, false);
  assert.equal(v('2026-10-05T00:00:00Z', 48).symbol, '✓');
  const late = v('2026-09-16T12:00:00Z', 336);
  assert.equal(late.late, true);
  assert.equal(late.symbol, '◐');
  assert.equal(late.widthPct, 100);
  assert.equal(v('2026-10-06T12:00:00Z', 48).widthPct, 0);
  assert.equal(freshnessView('not a date', 48, now), null);
});

const names = (fsg: string) => `Group ${fsg}`;
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ fsg: String(10 + i), open: 1000 - i * 20, closing7: (i % 5) * 20 + 10 }));

test('demand tiles: below 3 groups nothing; 14 groups all shown; 15+ fold into Other groups', () => {
  assert.equal(buildDemandTiles(rows(2), names, () => true), null);
  assert.equal(buildDemandTiles([...rows(2), { fsg: '99', open: 0, closing7: 0 }], names, () => true), null);
  assert.equal(buildDemandTiles(rows(3), names, () => true)?.length, 3);
  const fourteen = buildDemandTiles(rows(14), names, () => true)!;
  assert.equal(fourteen.length, 14);
  assert.ok(!fourteen.some((t) => t.fsg === null));
  const twenty = buildDemandTiles(rows(20), names, () => true)!;
  assert.equal(twenty.length, 14);
  const other = twenty.find((t) => t.fsg === null)!;
  assert.equal(other.name, 'Other groups');
  assert.equal(other.groups, 7);
  assert.equal(other.open, rows(20).slice(13).reduce((a, r) => a + r.open, 0));
  assert.equal(other.href, null);
  assert.equal(twenty.reduce((a, t) => a + t.open, 0), rows(20).reduce((a, r) => a + r.open, 0));
});

test('demand tiles: shade bins against the largest share, links only where a page exists', () => {
  const t = buildDemandTiles(
    [{ fsg: '53', open: 100, closing7: 50 }, { fsg: '59', open: 100, closing7: 25 }, { fsg: '48', open: 100, closing7: 0 }, { fsg: '47', open: 100, closing7: 5 }],
    names,
    (f) => f !== '59'
  )!;
  const by = Object.fromEntries(t.map((x) => [x.fsg, x]));
  assert.equal(by['53'].bin, 4);
  assert.equal(by['59'].bin, 2);
  assert.equal(by['48'].bin, 0);
  assert.equal(by['47'].bin, 0);
  assert.equal(by['53'].href, '/group/53/');
  assert.equal(by['59'].href, null);
  assert.equal(by['53'].share, 0.5);
  const none = buildDemandTiles(rows(3).map((r) => ({ ...r, closing7: 0 })), names, () => true)!;
  assert.ok(none.every((x) => x.bin === 0));
});

test('tile labels: English name wrapped to fit, never a bare code; count line when there is room', () => {
  const hw = { fsg: '53', name: 'Hardware and Abrasives', open: 2910 };
  assert.deepEqual(tileLabels(hw, 300, 100), { lines: ['Hardware and abrasives'], count: '2,910 open' });
  assert.deepEqual(tileLabels(hw, 100, 100), { lines: ['Hardware and', 'abrasives'], count: '2,910 open' });
  // The official long title is replaced by the short label and wrapped.
  const el = { fsg: '59', name: 'Electrical and Electronic Equipment Components', open: 1620 };
  assert.deepEqual(tileLabels(el, 150, 200), { lines: ['Electrical components'], count: '1,620 open' });
  assert.deepEqual(tileLabels(el, 90, 200), { lines: ['Electrical', 'components'], count: '1,620 open' });
  // A narrow tile clips with an ellipsis rather than showing "FSG 41".
  const ac = { fsg: '41', name: 'Refrigeration, Air Conditioning, and Air Circulating Equipment', open: 200 };
  const narrow = tileLabels(ac, 60, 160);
  assert.ok(narrow.lines.length >= 1 && narrow.lines.every((l) => l.length <= 7 && !/^FSG|^\d/.test(l)), JSON.stringify(narrow));
  assert.match(narrow.lines.join(' '), /…/);
  // Too small for a readable word: no label at all.
  assert.deepEqual(tileLabels(hw, 40, 100), { lines: [], count: null });
  assert.deepEqual(tileLabels(hw, 300, 20), { lines: [], count: null });
  // One row of height: the name only.
  assert.deepEqual(tileLabels(hw, 300, 30), { lines: ['Hardware and abrasives'], count: null });
  // A group with no short label falls back to its own name; the catch-all keeps its name.
  assert.deepEqual(tileLabels({ fsg: '00', name: 'Unlisted supply class', open: 3 }, 300, 100).lines, ['Unlisted supply class']);
  assert.deepEqual(tileLabels({ fsg: null, name: 'Other groups', open: 5 }, 120, 100), { lines: ['Other groups'], count: '5 open' });
  assert.ok(labelFits('abcd', 14 + 4 * 6.3));
  assert.ok(!labelFits('abcd', 14 + 4 * 6.3 - 0.1));
});

test('layout fills the box and areas follow open counts', () => {
  const tiles = buildDemandTiles(rows(8), names, () => true)!;
  const rects = layoutDemandTiles(tiles, 1160, 280);
  const area = rects.reduce((a, r) => a + r.w * r.h, 0);
  assert.ok(Math.abs(area - 1160 * 280) < 1);
  const total = tiles.reduce((a, t) => a + t.open, 0);
  for (const r of rects) assert.ok(Math.abs((r.w * r.h) / (1160 * 280) - r.item.open / total) < 1e-9);
});
