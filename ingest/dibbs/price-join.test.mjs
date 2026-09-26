// ingest/dibbs/price-join.test.mjs
// Unit tests for the pure award->pub.solicitations price-join mapping
// (load.mjs's mapAwardToPricePoint) — no database, no network. Exercises
// the normalization that makes the join work (dashless award solicitation
// numbers vs dashed pub.solicitations rows) and the data-honesty skip
// guards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAwardToPricePoint } from './load.mjs';
import { norm } from './join-validate.mjs';

function fakeSolicitationsMap(entries) {
  const map = new Map();
  for (const [solNumber, meta] of entries) {
    map.set(norm(solNumber), { sol_number: solNumber, ...meta });
  }
  return map;
}

function baseAward(overrides = {}) {
  return {
    awardNumber: 'SPE7L726T2303-0001',
    deliveryOrder: null,
    cage: null,
    total: 5000,
    awardDate: '2026-07-18',
    postedDate: '2026-07-18',
    nsnRaw: '5331010602663',
    nomenclature: 'RING,RETAINING',
    purchaseRequest: null,
    solicitation: 'SPE7L726T2303',
    ...overrides,
  };
}

test('norm() strips dashes so a dashless award solicitation matches a dashed persisted one', () => {
  assert.equal(norm('SPE7L726T2303'), norm('SPE7L7-26-T-2303'));
  assert.equal(norm('SPE7L726T2303'), 'SPE7L726T2303');
});

test('matches an award to a persisted (dashed) solicitation and computes unit_price = total / quantity', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 100 }],
  ]);

  const result = mapAwardToPricePoint(baseAward(), solicitationsByNorm);

  assert.equal(result.matched, true);
  assert.equal(result.skip, undefined);
  assert.equal(result.unit_price, 50);
  assert.equal(result.nsn, '5331010602663');
  assert.equal(result.sol_number, 'SPE7L7-26-T-2303');
  assert.equal(result.quantity, 100);
  assert.equal(result.total_value, 5000);
  assert.equal(result.award_ref, 'SPE7L726T2303-0001');
  assert.equal(result.awarded_on, '2026-07-18');
  assert.match(result.source_url, /AwdRecs\.aspx\?category=awdnsn&TypeSrch=cq&Value=5331010602663$/);
});

test('appends the delivery order to award_ref when present', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(
    baseAward({ deliveryOrder: '0002' }),
    solicitationsByNorm
  );
  assert.equal(result.award_ref, 'SPE7L726T2303-0001-0002');
});

test('DATA-HONESTY: skips (matched=true) when the matched solicitation has quantity 0', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 0 }],
  ]);
  const result = mapAwardToPricePoint(baseAward(), solicitationsByNorm);
  assert.equal(result.matched, true);
  assert.match(result.skip, /quantity/);
  assert.equal(result.unit_price, undefined);
});

test('DATA-HONESTY: skips (matched=true) when the matched solicitation has null quantity', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: null }],
  ]);
  const result = mapAwardToPricePoint(baseAward(), solicitationsByNorm);
  assert.equal(result.matched, true);
  assert.match(result.skip, /quantity/);
});

test('DATA-HONESTY: skips (matched=true) when the matched solicitation has no nsn', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: null, quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(baseAward(), solicitationsByNorm);
  assert.equal(result.matched, true);
  assert.match(result.skip, /nsn/);
});

test('DATA-HONESTY: skips when the award total is not a positive number', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(baseAward({ total: 0 }), solicitationsByNorm);
  assert.equal(result.matched, false);
  assert.ok(result.skip);
});

test('skips (matched=false) when no persisted solicitation matches', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE1C1-26-Q-0372', { nsn: '5331010602663', quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(baseAward(), solicitationsByNorm);
  assert.equal(result.matched, false);
  assert.equal(result.skip, 'no matching persisted solicitation');
});

test('skips (matched=false) when the award record has no solicitation number', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(baseAward({ solicitation: null }), solicitationsByNorm);
  assert.equal(result.matched, false);
});

test('skips when the award record has no awardDate', () => {
  const solicitationsByNorm = fakeSolicitationsMap([
    ['SPE7L7-26-T-2303', { nsn: '5331010602663', quantity: 100 }],
  ]);
  const result = mapAwardToPricePoint(baseAward({ awardDate: null }), solicitationsByNorm);
  assert.equal(result.matched, true);
  assert.match(result.skip, /awardDate/);
});
