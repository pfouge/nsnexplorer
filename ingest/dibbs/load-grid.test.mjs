// ingest/dibbs/load-grid.test.mjs
// node:test suite for planGridRow — the pure, DB-free decision function
// loadAwardGridActions (load.mjs) uses to accept/reject and shape each
// parseAwardGrid record before writing pub.nsns / pub.suppliers /
// pub.contract_actions. No DB access here on purpose.
//
// Run: node --test ingest/dibbs/load-grid.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGridRow } from './load.mjs';

const DEEP_FSCS = new Set(['5331', '5310']);

/** Baseline valid parseAwardGrid record; tests override fields as needed. */
function baseRecord(overrides = {}) {
  return {
    awardNumber: 'SPE7L726T2303',
    deliveryOrder: null,
    cage: '1a2b3',
    total: 8644.84,
    awardDate: '2026-07-10',
    postedDate: '2026-07-10',
    nsnRaw: '5331002915924',
    nomenclature: 'O-RING',
    purchaseRequest: '7015819485',
    solicitation: 'SPE7L726T2303',
    ...overrides,
  };
}

test('non-NSN nsnRaw is skipped', () => {
  const rec = baseRecord({ nsnRaw: 'DA10V00014345' });
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(plan.skip, 'expected a skip result');
  assert.equal(plan.skip, 'unparseable NSN');
});

test('NSN with FSC outside the deep set is skipped', () => {
  const rec = baseRecord({ nsnRaw: '9999002915924' }); // FSC 9999 not in DEEP_FSCS
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(plan.skip, 'expected a skip result');
  assert.equal(plan.skip, 'fsc not in deep set');
});

test('null total is skipped', () => {
  const rec = baseRecord({ total: null });
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(plan.skip, 'expected a skip result');
  assert.equal(plan.skip, 'missing total');
});

test('null awardDate is skipped', () => {
  const rec = baseRecord({ awardDate: null });
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(plan.skip, 'expected a skip result');
  assert.equal(plan.skip, 'missing award date');
});

test('a good row produces expected award_uid/piid/psc/raw.nsn', () => {
  const rec = baseRecord({ deliveryOrder: 'AA' });
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(!plan.skip, `expected an accepted plan, got skip: ${plan.skip}`);

  assert.equal(plan.nsn, '5331002915924');
  assert.equal(plan.fsc, '5331');
  assert.equal(plan.psc, '5331');
  assert.equal(plan.piid, 'SPE7L726T2303/AA');
  assert.equal(plan.award_uid, 'DIBBS-SPE7L726T2303-AA-7015819485');
  assert.equal(plan.raw.nsn, '5331002915924');
  assert.equal(plan.cage, '1A2B3');
  assert.equal(plan.item_name, 'O-RING');
  assert.equal(plan.action_date, '2026-07-10');
  assert.equal(plan.obligation, 8644.84);
});

test('an invalid CAGE normalizes to null (not the raw text)', () => {
  const rec = baseRecord({ cage: 'bad-cage' });
  const plan = planGridRow(rec, DEEP_FSCS);
  assert.ok(!plan.skip);
  assert.equal(plan.cage, null);
  assert.equal(plan.raw.cage, null);
});

test('consolidated rows differing only by purchaseRequest produce distinct award_uids', () => {
  const recA = baseRecord({ deliveryOrder: 'AA', purchaseRequest: '7015819485' });
  const recB = baseRecord({ deliveryOrder: 'AA', purchaseRequest: '7015819999' });

  const planA = planGridRow(recA, DEEP_FSCS);
  const planB = planGridRow(recB, DEEP_FSCS);

  assert.ok(!planA.skip && !planB.skip, 'expected both rows accepted');
  assert.notEqual(planA.award_uid, planB.award_uid);
  // Same underlying award + delivery order, so piid stays identical —
  // only the PR-qualified award_uid distinguishes them.
  assert.equal(planA.piid, planB.piid);
});
