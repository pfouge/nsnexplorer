import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigUsd, collectCages, eightKLabel, mapParent } from './public-parent.ts';

test('mapParent maps the supplier page JSON and builds the SEC link', () => {
  const p = mapParent({
    cik: '0000101829', ticker: 'RTX', name: 'RTX', revenue: '88603000000', revenue_period_end: '2025-12-31',
    lobbying: 13060000, lobbying_label: '2026', events: [{ filed: '2026-10-20', item: '2.02', url: 'https://www.sec.gov/x' }, { filed: null }],
    stm_url: 'https://spotthemoney.com/stocks/rtx/', as_of: '2026-11-24', siblings: 7,
    sibling_rows: [{ cage: '04071', name: 'RAYTHEON COMPANY', city: 'Tucson', state: 'AZ', d12: '1200' }],
  });
  assert.ok(p);
  assert.equal(p.revenue, 88603000000);
  assert.equal(p.events.length, 1);
  assert.equal(p.siblingRows[0].place, 'Tucson, AZ');
  assert.match(p.secUrl, /CIK=0000101829/);
  assert.equal(mapParent(null), null);
  assert.equal(mapParent({ ticker: '' }), null);
});

test('labels and money', () => {
  assert.equal(eightKLabel('2.02'), 'Reported quarterly results');
  assert.equal(eightKLabel('6.66'), 'Form 8-K item 6.66');
  assert.equal(bigUsd(88603000000), '$88.6 billion');
  assert.equal(bigUsd(13060000), '$13.1 million');
});

test('collectCages finds every cage-like key', () => {
  const s = collectCages({ a: [{ cage: '04071' }, { cage: null }], b: { streakCage: '1Y249', deep: [{ cage: 'bad' }] } });
  assert.deepEqual([...s].sort(), ['04071', '1Y249']);
});
