import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsByFiscalYear, csvFiscalYear, CSV_MAX_ROWS, latestYearActions } from './csv-split.ts';

test('csvFiscalYear follows the federal fiscal year', () => {
  assert.equal(csvFiscalYear('2026-09-30'), 2026);
  assert.equal(csvFiscalYear('2026-10-01'), 2027);
  assert.equal(csvFiscalYear('2026-01-15T00:00:00Z'), 2026);
  assert.equal(csvFiscalYear(null), null);
  assert.equal(csvFiscalYear('n/a'), null);
});

test('latestYearActions keeps 365 days back from the build date', () => {
  const rows = ['2027-03-22', '2026-08-12', '2026-01-01', '2025-08-13', '2025-08-12', '2024-01-01', null].map((actionDate) => ({ actionDate }));
  assert.deepEqual(latestYearActions(rows, '2026-08-12').map((r) => r.actionDate), ['2027-03-22', '2026-08-12', '2026-01-01', '2025-08-13']);
  assert.deepEqual(latestYearActions([{ actionDate: null }], '2026-08-12'), []);
  assert.deepEqual(latestYearActions([], '2026-08-12'), []);
});

test('actionsByFiscalYear groups newest year first, drops undated rows and caps a year', () => {
  const rows = ['2026-10-02', '2026-09-30', '2025-11-01', '2024-12-01', null].map((actionDate) => ({ actionDate }));
  const by = actionsByFiscalYear(rows);
  assert.deepEqual([...by.keys()], [2027, 2026, 2025]);
  assert.equal(by.get(2026)!.length, 2);
  const many = Array.from({ length: CSV_MAX_ROWS + 5 }, () => ({ actionDate: '2026-03-01' }));
  assert.equal(actionsByFiscalYear(many).get(2026)!.length, CSV_MAX_ROWS);
});
