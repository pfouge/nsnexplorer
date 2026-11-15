import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClassPulse, daysBetween, supplierKey } from './class-pulse.ts';

const TODAY = '2026-11-14';
const ago = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
const ahead = (n: number) => ago(-n);

test('daysBetween handles month and year edges and bad input', () => {
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.equal(daysBetween('2026-11-14', '2026-11-14'), 0);
  assert.equal(daysBetween('nope', '2026-11-14'), null);
});

test('supplierKey prefers the id, falls back to a normalised name', () => {
  assert.equal(supplierKey(' 1abc2 ', 'X'), 'id:1ABC2');
  assert.equal(supplierKey(null, '  Acme   Corp '), 'name:acme corp');
  assert.equal(supplierKey('', ''), null);
  assert.equal(supplierKey(undefined, undefined), null);
});

test('open bids: count includes all, closing-soon is today..+7 inclusive', () => {
  const p = buildClassPulse(TODAY, [
    { returnBy: TODAY }, { returnBy: ahead(7) }, { returnBy: ahead(8) }, { returnBy: ago(1) }, { returnBy: null },
  ], []);
  assert.deepEqual(p.open, { count: 5, closingSoon: 2 });
});

test('no solicitations is a real zero', () => {
  assert.deepEqual(buildClassPulse(TODAY, [], []).open, { count: 0, closingSoon: 0 });
});

test('awards: 90-day window is inclusive of day 89, excludes day 90 and the future', () => {
  const a = (date: string | null, amount: number) => ({ date, amount, supplierKey: null });
  const p = buildClassPulse(TODAY, [], [a(TODAY, 10), a(ago(89), 20), a(ago(90), 40), a(ahead(1), 80), a(null, 160)]);
  assert.deepEqual(p.awarded90, { count: 2, dollars: 30 });
});

test('awards: absent when there are no dated records; zero-count when all are old', () => {
  assert.equal(buildClassPulse(TODAY, [], []).awarded90, null);
  assert.equal(buildClassPulse(TODAY, [], [{ date: null, amount: 5, supplierKey: null }]).awarded90, null);
  assert.deepEqual(buildClassPulse(TODAY, [], [{ date: ago(400), amount: 5, supplierKey: 'id:A' }]).awarded90, { count: 0, dollars: 0 });
});

test('suppliers: distinct over 365 days, unknown ignored, absent when none', () => {
  const w = (date: string, supplierKey: string | null) => ({ date, amount: 1, supplierKey });
  const p = buildClassPulse(TODAY, [], [w(ago(1), 'id:A'), w(ago(200), 'id:A'), w(ago(364), 'id:B'), w(ago(365), 'id:C'), w(ago(5), null)]);
  assert.deepEqual(p.suppliers12, { count: 2 });
  assert.equal(buildClassPulse(TODAY, [], [w(ago(5), null), w(ago(500), 'id:A')]).suppliers12, null);
});

test('non-finite amounts do not poison the sum', () => {
  const p = buildClassPulse(TODAY, [], [{ date: TODAY, amount: NaN, supplierKey: null }, { date: TODAY, amount: 7, supplierKey: null }]);
  assert.deepEqual(p.awarded90, { count: 2, dollars: 7 });
});
