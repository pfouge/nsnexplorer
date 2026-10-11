import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonths, chartable, defaultMode, monthLabel, type MonthInput } from './viz-supplier.ts';

const months = (f: (i: number) => [number, number]): MonthInput[] =>
  Array.from({ length: 24 }, (_, i) => {
    const y = 2024 + Math.floor((10 + i) / 12);
    const m = ((10 + i) % 12) + 1;
    const [awards, dollars] = f(i);
    return { month: `${y}-${String(m).padStart(2, '0')}`, awards, dollars };
  });

test('month labels', () => {
  assert.equal(monthLabel('2026-10'), 'Oct 2026');
  assert.equal(monthLabel('2025-01'), 'Jan 2025');
});

test('chartable needs awards in two months; dollars mode needs dollars in two months', () => {
  assert.equal(chartable(months(() => [0, 0])), false);
  assert.equal(chartable(months((i) => (i === 3 ? [2, 10] : [0, 0]))), false);
  assert.equal(chartable(months((i) => (i === 3 || i === 9 ? [2, 10] : [0, 0]))), true);
  assert.equal(defaultMode(months((i) => (i % 2 ? [1, 0] : [1, 50]))), 'dollars');
  assert.equal(defaultMode(months((i) => (i === 2 ? [1, 5] : [1, 0]))), 'awards');
});

test('buildMonths: 24 bars, axis covers the tallest bar, labels every third month ending on the last', () => {
  const m = buildMonths(months((i) => [i, i * 1000]), 'dollars');
  assert.equal(m.bars.length, 24);
  assert.ok(m.top >= 23000);
  assert.equal(m.bars[23].value, 23000);
  assert.equal(m.labels[m.labels.length - 1].i, 23);
  assert.deepEqual(m.labels.map((l) => l.i).slice(-3), [17, 20, 23]);
  const a = buildMonths(months((i) => [i % 2, 0]), 'awards');
  assert.equal(a.top, 1);
  assert.equal(a.bars[1].value, 1);
});
