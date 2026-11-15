import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_TITLE, allTimeNote, boardDescription, compactUsd, isLongTermOnly, isSmallBusiness, isSmallLabel, leaderboardHeaders, leaderboardRows, listFor,
  longTermOnlyList, longTermText, rankTrend, signedUsd,
  type BoardData, type BoardSupplier,
} from './supplier-board.ts';
import { toCsv } from './csv.ts';

const headerIndex = (h: string) => (leaderboardHeaders as readonly string[]).indexOf(h);
const sup = (cage: string, o: Partial<BoardSupplier> = {}): BoardSupplier => ({
  cage, name: `Supplier ${cage}`, city: 'Dayton', state: 'OH', awardsAll: 5, dollarsAll: 1000, awards12m: 3, dollars12m: 500,
  awardsPrior12m: 2, dollarsPrior12m: 500, nsns: 3, fscs: 2, risingDelta: 0, rankDollars12m: null, rankDollarsAll: null,
  rankWins12m: null, rankWinsAll: null, rankNsns: null, rankFscs: null, rankRising: null, awards90d: 1, dollars90d: 100, rankDollars90d: null,
  rankWins90d: null, rankDollars12mPrev: null, longTermContracts: 0, ...o,
});

test('listFor: rank order, only ranks 1..size, ties by CAGE', () => {
  const s = [sup('B', { rankDollars12m: 2 }), sup('A', { rankDollars12m: 1 }), sup('C', { rankDollars12m: 101 }), sup('D'), sup('E', { rankDollars12m: 2 })];
  assert.deepEqual(listFor(s, 'dollars-12m').map((x) => x.cage), ['A', 'B', 'E']);
  assert.deepEqual(listFor(s, 'dollars-12m', 1).map((x) => x.cage), ['A']);
  assert.deepEqual(listFor(s, 'rising'), []);
});

test('small business: any small NAICS or a small-business label, not "Other than Small Business"', () => {
  assert.equal(isSmallLabel('Small Business'), true);
  assert.equal(isSmallLabel('Woman Owned Small Business'), true);
  assert.equal(isSmallLabel('Small Disadvantaged Business'), true);
  assert.equal(isSmallLabel('Other than Small Business'), false);
  assert.equal(isSmallLabel('Subchapter S Corporation'), false);
  assert.equal(isSmallBusiness(['Other than Small Business'], [{ small: false }]), false);
  assert.equal(isSmallBusiness(['Other than Small Business'], [{ small: false }, { small: true }]), true);
  assert.equal(isSmallBusiness(['Small Business'], []), true);
  assert.equal(isSmallBusiness([], []), false);
});

test('csv: every list, rank order, headers match the rows', () => {
  const data: BoardData = {
    headline: { suppliers: 2, awards12m: 6, dollars12m: 1000, small: 1, withSam: 1, states: 1, asOf: '2026-10-11', coverageFrom: '2026-07-13', longTermOnly: 1 },
    suppliers: [
      sup('A', { rankDollars12m: 1, rankWins12m: 2, name: '=EVIL, "Inc"' }),
      sup('B', { rankDollars12m: 2, rankWins12m: 1, rankRising: 1, rankDollars90d: 1, rankDollars12mPrev: 5 }),
      sup('C', { awardsAll: 0, dollarsAll: 0, awards12m: 0, dollars12m: 0, awards90d: 0, dollars90d: 0, longTermContracts: 2 }),
    ],
    states: [],
  };
  const rows = leaderboardRows(data);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.length === leaderboardHeaders.length));
  assert.deepEqual(rows.map((r) => `${r[0]}:${r[1]}:${r[2]}`), [
    'dollars_90d:1:B', 'dollars_12m:1:A', 'dollars_12m:2:B', 'wins_12m:1:B', 'wins_12m:2:A', 'rising:1:B', 'long_term_only:null:C',
  ]);
  const last = headerIndex('long_term_contracts');
  assert.equal(rows[6][last], 2);
  assert.equal(rows[2][headerIndex('rank_dollars_12m_30_days_ago')], 5);
  assert.equal(leaderboardHeaders.indexOf('as_of'), 14, 'existing column positions did not move');
  const csv = toCsv(leaderboardHeaders, rows);
  assert.match(csv, /"'=EVIL, ""Inc"""/);
});

test('copy: title with suffix <= 70, description 140-160 for any supplier count', () => {
  assert.ok(`${BOARD_TITLE} · NSN Explorer`.length <= 70);
  for (const n of [0, 1, 9, 99, 1234, 99999, 1234567]) {
    const d = boardDescription(n);
    assert.ok(d.length >= 140 && d.length <= 160, `${n}: ${d.length}`);
    assert.doesNotMatch(d, /undefined|NaN|—/);
  }
});

test('money formats', () => {
  assert.equal(compactUsd(950), '$950');
  assert.equal(compactUsd(480_000), '$480K');
  assert.equal(compactUsd(12_340_000), '$12.3M');
  assert.equal(signedUsd(1_200_000), '+$1.2M');
  assert.equal(signedUsd(-800), '-$800');
  assert.equal(signedUsd(0), '$0');
});

test('listFor: the 90-day lists rank on their own columns', () => {
  const s = [sup('A', { rankDollars90d: 2, rankWins90d: 1 }), sup('B', { rankDollars90d: 1 }), sup('C', { rankDollars12m: 1 })];
  assert.deepEqual(listFor(s, 'dollars-90d').map((x) => x.cage), ['B', 'A']);
  assert.deepEqual(listFor(s, 'wins-90d').map((x) => x.cage), ['A']);
});

test('rankTrend: smaller rank number is up; new when no rank 30 days ago; none without a rank today', () => {
  assert.deepEqual(rankTrend(3, 8), { kind: 'up', places: 5, glyph: '\u25B2 5', text: 'Up 5 places since 30 days ago' });
  assert.deepEqual(rankTrend(8, 3), { kind: 'down', places: 5, glyph: '\u25BC 5', text: 'Down 5 places since 30 days ago' });
  assert.equal(rankTrend(2, 3)?.text, 'Up 1 place since 30 days ago');
  assert.equal(rankTrend(3, 2)?.text, 'Down 1 place since 30 days ago');
  assert.deepEqual(rankTrend(4, 4), { kind: 'same', places: 0, glyph: '=', text: 'No change since 30 days ago' });
  assert.equal(rankTrend(4, null)?.kind, 'new');
  assert.equal(rankTrend(4, null)?.glyph, 'new');
  assert.equal(rankTrend(null, 4), null);
  assert.equal(rankTrend(null, null), null);
  // Every state carries words, so colour is never the only signal.
  for (const t of [rankTrend(1, 2), rankTrend(2, 1), rankTrend(1, 1), rankTrend(1, null)]) assert.ok(t && t.text.length > 8 && t.glyph.length > 0);
});

test('long-term contract only suppliers: listed by contracts then CAGE, never ranked, plain text', () => {
  const zero = { awardsAll: 0, dollarsAll: 0, awards12m: 0, dollars12m: 0 };
  const s = [
    sup('B', { ...zero, longTermContracts: 1 }),
    sup('A', { ...zero, longTermContracts: 1 }),
    sup('C', { ...zero, longTermContracts: 3 }),
    sup('D', { longTermContracts: 4 }), // has purchases: not on this list
    sup('E', { ...zero, longTermContracts: 0 }),
  ];
  assert.deepEqual(longTermOnlyList(s).map((x) => x.cage), ['C', 'A', 'B']);
  assert.deepEqual(longTermOnlyList(s, 2).map((x) => x.cage), ['C', 'A']);
  assert.equal(isLongTermOnly(s[3]), false);
  assert.equal(longTermText(1), '1 long-term contract, no orders yet');
  assert.equal(longTermText(80), '80 long-term contracts, no orders yet');
  assert.equal(longTermText(1200), '1,200 long-term contracts, no orders yet');
  assert.doesNotMatch(longTermText(2), /\u2014/);
});

test('all-time note: names the coverage date when known, says so honestly when not', () => {
  assert.equal(allTimeNote('Jul 13, 2026'), 'All time means since Jul 13, 2026: our DIBBS award records are dense only from that date.');
  assert.match(allTimeNote(null), /every award we have indexed so far/);
  assert.doesNotMatch(allTimeNote(null) + allTimeNote('Jul 13, 2026'), /\u2014/);
});
