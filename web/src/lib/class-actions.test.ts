import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fiscalYearBounds,
  hasUsaspendingActions,
  isUsaspendingRow,
  PULSE_LOOKBACK_DAYS,
  PULSE_LOOKBACK_MARGIN_DAYS,
  pulseAwardRows,
  pulseLookbackFloor,
  USASPENDING_URL_REGEX,
  usaspendingFiscalYears,
  type ClassActionSummary,
} from './class-actions.ts';
import { AWARD_WINDOW_DAYS, buildClassPulse, SUPPLIER_WINDOW_DAYS } from './class-pulse.ts';
import { csvFiscalYear, latestYearFloor, latestYearActions } from './csv-split.ts';

const summary = (over: Partial<ClassActionSummary> = {}): ClassActionSummary => ({
  count: 0, obligated: 0, recent: [], usaspendingCount: 0, usaspendingFiscalYears: [], latestDate: null, pulseRows: [], ...over,
});

test('the pulse look-back covers the longest window class-pulse reads', () => {
  assert.equal(PULSE_LOOKBACK_DAYS, Math.max(SUPPLIER_WINDOW_DAYS, AWARD_WINDOW_DAYS));
  assert.ok(PULSE_LOOKBACK_MARGIN_DAYS >= 1);
  // 2026-11-15 minus (365 + 7) days
  assert.equal(pulseLookbackFloor('2026-11-15'), '2025-11-08');
  assert.equal(pulseLookbackFloor('2024-03-01'), '2023-02-23');
});

test('pulse rows cut at the floor give the same pulse as the full row set', () => {
  const today = '2026-11-15';
  const all = ['2027-01-01', '2026-11-16', '2026-11-15', '2026-08-18', '2026-08-17', '2025-11-16', '2025-11-15', '2025-11-08', '2025-11-07', '2020-01-01'].map(
    (date, i) => ({ date, amount: 100 + i, supplierKey: `id:S${i}` })
  );
  const floor = pulseLookbackFloor(today);
  const kept = all.filter((a) => a.date >= floor && a.date <= today);
  assert.deepEqual(buildClassPulse(today, [], kept), buildClassPulse(today, [], all));
});

test('pulseAwardRows adds one zero-amount marker only when dated rows exist but none are in the window', () => {
  assert.deepEqual(pulseAwardRows(undefined), []);
  assert.deepEqual(pulseAwardRows(summary()), []);
  const today = '2026-11-15';
  for (const latest of ['2027-01-15', '2019-02-02']) {
    const rows = pulseAwardRows(summary({ latestDate: latest }));
    assert.equal(rows.length, 1);
    const withMarker = buildClassPulse(today, [], rows.map((r) => ({ date: r.date, amount: r.amount, supplierKey: null })));
    assert.deepEqual(withMarker, { open: { count: 0, closingSoon: 0 }, awarded90: { count: 0, dollars: 0 }, suppliers12: null });
  }
  const inWindow = pulseAwardRows(
    summary({ latestDate: '2026-11-10', pulseRows: [{ actionDate: '2026-11-10', obligation: null, recipientUei: 'U1', recipientName: null }] })
  );
  assert.deepEqual(inWindow, [{ date: '2026-11-10', amount: 0, recipientUei: 'U1', recipientName: null }]);
});

test('fiscal years and CSV availability come from the summary', () => {
  const s = summary({ usaspendingCount: 3, usaspendingFiscalYears: [{ fy: 2027, count: 1 }, { fy: 2025, count: 2 }] });
  assert.deepEqual(usaspendingFiscalYears(s), [2027, 2025]);
  assert.deepEqual(usaspendingFiscalYears(undefined), []);
  assert.equal(hasUsaspendingActions(s), true);
  assert.equal(hasUsaspendingActions(summary({ count: 5 })), false);
  assert.equal(hasUsaspendingActions(undefined), false);
});

test('fiscalYearBounds agrees with csvFiscalYear at the edges', () => {
  for (const fy of [2016, 2026, 2027]) {
    const { start, endExclusive } = fiscalYearBounds(fy);
    assert.equal(csvFiscalYear(start), fy);
    assert.equal(csvFiscalYear(endExclusive), fy + 1);
    const lastDay = new Date(Date.parse(`${endExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    assert.equal(csvFiscalYear(lastDay), fy);
  }
  assert.deepEqual(fiscalYearBounds(2026), { start: '2025-10-01', endExclusive: '2026-10-01' });
});

test('latestYearFloor matches latestYearActions', () => {
  assert.equal(latestYearFloor('2026-08-12'), '2025-08-12');
  const rows = ['2025-08-12', '2025-08-13'].map((actionDate) => ({ actionDate }));
  assert.deepEqual(latestYearActions(rows, '2026-08-12').map((r) => r.actionDate), ['2025-08-13']);
});

test('the SQL host pattern (as a JS regex) agrees with isUsaspendingRow', () => {
  const re = new RegExp(USASPENDING_URL_REGEX, 'i');
  const urls: [string, boolean][] = [
    ['https://www.usaspending.gov/award/CONT_AWD_1', true],
    ['https://usaspending.gov/award/1', true],
    ['https://api.usaspending.gov:443/x', true],
    ['HTTPS://Sub.USAspending.GOV/x', true],
    ['https://user:pw@usaspending.gov/x', true],
    ['https://www.usaspending.gov?x=1', true],
    ['https://usaspending.gov', true],
    ['http://a.b.usaspending.gov/x', true],
    ['https://usaspending.gov.evil.com/x', false],
    ['https://evilusaspending.gov/x', false],
    ['https://example.com/?u=usaspending.gov', false],
    ['https://example.com#@usaspending.gov/', false],
    ['usaspending.gov/x', false],
    ['https://usaspending.gov:abc/x', false],
    ['https://www.usaspending.gov./x', false],
    ['https://www.dibbs.bsm.dla.mil/Awards', false],
    ['', false],
  ];
  for (const [url, expected] of urls) {
    assert.equal(isUsaspendingRow('CONT_AWD_1', url), expected, `js ${url}`);
    assert.equal(re.test(url), expected, `regex ${url}`);
  }
  assert.equal(isUsaspendingRow('DIBBS-1', 'https://www.usaspending.gov/x'), false);
});
