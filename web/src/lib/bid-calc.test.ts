import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustForTime, compare, parseMoney, parsePercent, quote, wholeMonths } from './bid-calc.ts';

const near = (a: number | null, b: number, eps = 1e-9) => {
  assert.notEqual(a, null);
  assert.ok(Math.abs((a as number) - b) < eps, `${a} vs ${b}`);
};
const NULLS = { unitPrice: null, marginPct: null, profitPerUnit: null, total: null, profitTotal: null };

test('quote: price from margin', () => {
  const q = quote({ unitCost: 80, marginPct: 20, unitPrice: null, quantity: 10 });
  near(q.unitPrice, 100);
  near(q.marginPct, 20);
  near(q.profitPerUnit, 20);
  near(q.total, 1000);
  near(q.profitTotal, 200);
});

test('quote: margin from price', () => {
  const q = quote({ unitCost: 60, marginPct: null, unitPrice: 80, quantity: 5 });
  near(q.unitPrice, 80);
  near(q.marginPct, 25);
  near(q.profitPerUnit, 20);
  near(q.total, 400);
  near(q.profitTotal, 100);
});

test('quote: margin is a share of price, not markup', () => {
  near(quote({ unitCost: 50, marginPct: 50, unitPrice: null, quantity: 1 }).unitPrice, 100);
});

test('quote: price wins when both are given', () => {
  const q = quote({ unitCost: 50, marginPct: 10, unitPrice: 100, quantity: 1 });
  near(q.unitPrice, 100);
  near(q.marginPct, 50);
});

test('quote: negative margin and price below cost', () => {
  near(quote({ unitCost: 100, marginPct: -25, unitPrice: null, quantity: 1 }).unitPrice, 80);
  const q = quote({ unitCost: 100, marginPct: null, unitPrice: 80, quantity: 2 });
  near(q.marginPct, -25);
  near(q.profitTotal, -40);
});

test('quote: invalid cost', () => {
  for (const unitCost of [0, -5, NaN, Infinity, null]) {
    assert.deepEqual(quote({ unitCost, marginPct: 20, unitPrice: null, quantity: 1 }), NULLS);
  }
});

test('quote: margin of 100 or more has no price', () => {
  assert.deepEqual(quote({ unitCost: 10, marginPct: 100, unitPrice: null, quantity: 1 }), NULLS);
  assert.deepEqual(quote({ unitCost: 10, marginPct: 150, unitPrice: null, quantity: 1 }), NULLS);
  assert.deepEqual(quote({ unitCost: 10, marginPct: NaN, unitPrice: null, quantity: 1 }), NULLS);
});

test('quote: missing or bad price and margin', () => {
  assert.deepEqual(quote({ unitCost: 10, marginPct: null, unitPrice: null, quantity: 1 }), NULLS);
  assert.deepEqual(quote({ unitCost: 10, marginPct: null, unitPrice: 0, quantity: 1 }), NULLS);
  assert.deepEqual(quote({ unitCost: 10, marginPct: null, unitPrice: -3, quantity: 1 }), NULLS);
  assert.deepEqual(quote({ unitCost: 10, marginPct: null, unitPrice: NaN, quantity: 1 }), NULLS);
});

test('quote: missing quantity keeps unit figures, drops order figures', () => {
  for (const quantity of [null, 0, -2, NaN]) {
    const q = quote({ unitCost: 80, marginPct: 20, unitPrice: null, quantity });
    near(q.unitPrice, 100);
    near(q.profitPerUnit, 20);
    assert.equal(q.total, null);
    assert.equal(q.profitTotal, null);
  }
});

test('quote: other cost per order is spread over the quantity', () => {
  const q = quote({ unitCost: 80, marginPct: null, unitPrice: 100, quantity: 10, otherCostPerOrder: 50 });
  near(q.marginPct, 20); // unit margin ignores the order-level cost
  near(q.profitPerUnit, 15);
  near(q.total, 1000);
  near(q.profitTotal, 150);
});

test('quote: other cost without a quantity cannot be spread', () => {
  const q = quote({ unitCost: 80, marginPct: 20, unitPrice: null, quantity: null, otherCostPerOrder: 50 });
  near(q.unitPrice, 100);
  assert.equal(q.profitPerUnit, null);
  assert.equal(q.profitTotal, null);
});

test('quote: bad other cost gives no profit figures', () => {
  for (const otherCostPerOrder of [-1, NaN]) {
    const q = quote({ unitCost: 80, marginPct: 20, unitPrice: null, quantity: 10, otherCostPerOrder });
    near(q.unitPrice, 100);
    assert.equal(q.profitPerUnit, null);
    assert.equal(q.profitTotal, null);
  }
  near(quote({ unitCost: 80, marginPct: 20, unitPrice: null, quantity: 10, otherCostPerOrder: null }).profitTotal, 200);
});

const S = { latest: 100, low: 90, high: 120, average: 105 };

test('compare: percent differences to one decimal', () => {
  const c = compare(110, S);
  assert.equal(c.vsLatestPct, 10);
  assert.equal(c.vsAveragePct, 4.8);
  assert.equal(compare(95, S).vsLatestPct, -5);
  assert.equal(compare(100.04, S).vsLatestPct, 0);
});

test('compare: positions and boundaries', () => {
  assert.equal(compare(89.99, S).position, 'below_range');
  assert.equal(compare(90, S).position, 'in_range');
  assert.equal(compare(105, S).position, 'in_range');
  assert.equal(compare(120, S).position, 'in_range');
  assert.equal(compare(120.01, S).position, 'above_range');
});

test('compare: nothing to compare', () => {
  const none = { vsLatestPct: null, vsAveragePct: null, position: null };
  assert.deepEqual(compare(100, null), none);
  assert.deepEqual(compare(null, S), none);
  assert.deepEqual(compare(0, S), none);
  assert.deepEqual(compare(NaN, S), none);
  assert.equal(compare(100, { latest: 0, low: 90, high: 120, average: 0 }).vsLatestPct, null);
});

test('wholeMonths', () => {
  assert.equal(wholeMonths('2025-01-15', '2025-01-15'), 0);
  assert.equal(wholeMonths('2025-01-15', '2025-02-14'), 0);
  assert.equal(wholeMonths('2025-01-15', '2025-02-15'), 1);
  assert.equal(wholeMonths('2024-11-30', '2026-05-30'), 18);
  assert.equal(wholeMonths('2025-02-01', '2025-01-01'), null);
  assert.equal(wholeMonths('2025-13-01', '2025-01-01'), null);
  assert.equal(wholeMonths('nope', '2025-01-01'), null);
});

test('adjustForTime: 0, 12 and 18 months', () => {
  near(adjustForTime(100, '2026-11-14', '2026-11-14', 5), 100);
  near(adjustForTime(100, '2026-11-14', '2026-12-01', 5), 100); // under a month
  near(adjustForTime(100, '2025-11-14', '2026-11-14', 5), 105);
  near(adjustForTime(100, '2025-05-14', '2026-11-14', 5), 100 * Math.pow(1.05, 1.5));
  near(adjustForTime(100, '2025-11-14', '2026-11-14', 0), 100);
  near(adjustForTime(100, '2025-11-14', '2026-11-14', -10), 90);
});

test('adjustForTime: invalid input', () => {
  assert.equal(adjustForTime(0, '2025-01-01', '2026-01-01', 5), null);
  assert.equal(adjustForTime(-1, '2025-01-01', '2026-01-01', 5), null);
  assert.equal(adjustForTime(NaN, '2025-01-01', '2026-01-01', 5), null);
  assert.equal(adjustForTime(100, '2025-01-01', '2026-01-01', NaN), null);
  assert.equal(adjustForTime(100, '2025-01-01', '2026-01-01', -100), null);
  assert.equal(adjustForTime(100, 'bad', '2026-01-01', 5), null);
  assert.equal(adjustForTime(100, '2026-01-01', '2025-01-01', 5), null);
});

test('parseMoney', () => {
  assert.equal(parseMoney('12'), 12);
  assert.equal(parseMoney('$1,234.50'), 1234.5);
  assert.equal(parseMoney(' $ 1 234 '), 1234);
  assert.equal(parseMoney('.5'), 0.5);
  assert.equal(parseMoney('7.'), 7);
  for (const bad of ['', '   ', '$', '0', '0.00', '-5', 'abc', '1.2.3', '12abc', '1e3', '--1']) assert.equal(parseMoney(bad), null, bad);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(undefined), null);
});

test('parsePercent', () => {
  assert.equal(parsePercent('20'), 20);
  assert.equal(parsePercent(' 12.5 % '), 12.5);
  assert.equal(parsePercent('0'), 0);
  assert.equal(parsePercent('-3'), -3);
  for (const bad of ['', '%', 'x', '1.2.3']) assert.equal(parsePercent(bad), null, bad);
  assert.equal(parsePercent(null), null);
});
