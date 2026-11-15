import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agencyLede, barWidth, compactUsd, fillFiscalYears, fiscalRange, fiscalYear, formatShare, share, truncateText } from './agency-profile.ts';

test('fiscal year boundaries', () => {
  assert.equal(fiscalYear('2026-09-30'), 2026);
  assert.equal(fiscalYear('2026-10-01'), 2027);
  assert.equal(fiscalYear('2026-01-01'), 2026);
  assert.equal(fiscalYear('2025-12-31'), 2026);
  assert.equal(fiscalYear('nope'), null);
});

test('share is a one-decimal percentage or null', () => {
  assert.equal(share(1, 3), 33.3);
  assert.equal(share(50, 50), 100);
  assert.equal(share(5, 0), null);
  assert.equal(share(5, -10), null);
  assert.equal(share(-5, 100), -5);
  assert.equal(formatShare(1, 3), '33.3%');
  assert.equal(formatShare(1, 0), '—');
  assert.equal(formatShare(0.01, 1000), '<0.1%');
  assert.equal(formatShare(-5, 100), '0.0%');
});

test('barWidth clamps to 0..100', () => {
  assert.equal(barWidth(50, 100), 50);
  assert.equal(barWidth(100, 100), 100);
  assert.equal(barWidth(150, 100), 100);
  assert.equal(barWidth(-20, 100), 0);
  assert.equal(barWidth(10, 0), 0);
  assert.equal(barWidth(1, 1000), 0);
  assert.equal(barWidth(1, 300), 0);
  assert.equal(barWidth(2, 300), 1);
});

test('truncateText cuts at a word and collapses whitespace', () => {
  assert.equal(truncateText('  short   text '), 'short text');
  assert.equal(truncateText(null), '');
  const out = truncateText('word '.repeat(40), 80);
  assert.ok(out.length <= 80 && out.endsWith('…'));
  assert.equal(truncateText('x'.repeat(100), 10), 'xxxxxxxxx…');
});

test('fillFiscalYears fills gaps in ascending order', () => {
  const rows = fillFiscalYears([{ fy: 2024, actions: 2, obligated: 5 }, { fy: 2022, actions: 1, obligated: 3 }]);
  assert.deepEqual(rows.map((r) => r.fy), [2022, 2023, 2024]);
  assert.deepEqual(rows[1], { fy: 2023, actions: 0, obligated: 0 });
  assert.deepEqual(fillFiscalYears([]), []);
});

test('fiscalRange and lede', () => {
  assert.equal(fiscalRange('2019-03-01', '2026-10-02'), 'FY2019–FY2027');
  assert.equal(fiscalRange('2026-01-01', '2026-02-01'), 'FY2026');
  assert.equal(fiscalRange(null, '2026-02-01'), null);
  assert.equal(compactUsd(1_234_000_000), '$1.2B');
  assert.equal(compactUsd(-2_500_000), '-$2.5M');
  assert.equal(compactUsd(950), '$950');
  assert.equal(
    agencyLede({ actions: 1200, obligated: 3_400_000, recipients: 1, firstDate: '2020-01-01', lastDate: '2026-05-01' }),
    '1,200 contract actions worth $3.4M to 1 supplier, FY2020–FY2026, from USAspending.'
  );
  assert.equal(agencyLede({ actions: 0, obligated: 0, recipients: 0, firstDate: null, lastDate: null }), null);
  assert.equal(agencyLede(undefined), null);
});
