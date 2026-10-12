import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_TITLE, boardDescription, compactUsd, isSmallBusiness, isSmallLabel, leaderboardHeaders, leaderboardRows, listFor, signedUsd,
  type BoardData, type BoardSupplier,
} from './supplier-board.ts';
import { toCsv } from './csv.ts';

const sup = (cage: string, o: Partial<BoardSupplier> = {}): BoardSupplier => ({
  cage, name: `Supplier ${cage}`, city: 'Dayton', state: 'OH', awardsAll: 5, dollarsAll: 1000, awards12m: 3, dollars12m: 500,
  awardsPrior12m: 2, dollarsPrior12m: 500, nsns: 3, fscs: 2, risingDelta: 0, rankDollars12m: null, rankDollarsAll: null,
  rankWins12m: null, rankWinsAll: null, rankNsns: null, rankFscs: null, rankRising: null, ...o,
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
    headline: { suppliers: 2, awards12m: 6, dollars12m: 1000, small: 1, withSam: 1, states: 1, asOf: '2026-10-11' },
    suppliers: [sup('A', { rankDollars12m: 1, rankWins12m: 2, name: '=EVIL, "Inc"' }), sup('B', { rankDollars12m: 2, rankWins12m: 1, rankRising: 1 })],
    states: [],
  };
  const rows = leaderboardRows(data);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.length === leaderboardHeaders.length));
  assert.deepEqual(rows.map((r) => `${r[0]}:${r[1]}:${r[2]}`), ['dollars_12m:1:A', 'dollars_12m:2:B', 'wins_12m:1:B', 'wins_12m:2:A', 'rising:1:B']);
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
