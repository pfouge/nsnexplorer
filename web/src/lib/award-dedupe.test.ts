import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dibbsActionRef, withoutDuplicatedPricePoints } from './award-dedupe.ts';

const pp = (nsn: string, awardRef: string, source = 'dibbs_award') => ({ nsn, awardRef, source });

test('dibbsActionRef: piid slash becomes the price-point dash; non-DIBBS and no piid give null', () => {
  assert.equal(dibbsActionRef({ awardUid: 'DIBBS-SPE7L127V0436-7018620303', piid: 'SPE7L127V0436' }), 'SPE7L127V0436');
  assert.equal(dibbsActionRef({ awardUid: 'DIBBS-SPE1-0002-77', piid: 'SPE1/0002' }), 'SPE1-0002');
  assert.equal(dibbsActionRef({ awardUid: 'CONT_AWD_X', piid: 'X' }), null);
  assert.equal(dibbsActionRef({ awardUid: 'DIBBS-A', piid: null }), null);
});

test('drops a dibbs_award price point whose award is a DIBBS action on the same NSN', () => {
  const actions = { '1': [{ awardUid: 'DIBBS-A1-9', piid: 'A1' }, { awardUid: 'DIBBS-B2-0001-8', piid: 'B2/0001' }] };
  const lookup = (n: string) => actions[n as '1'] ?? [];
  const kept = withoutDuplicatedPricePoints([pp('1', 'A1'), pp('1', 'B2-0001'), pp('1', 'C3'), pp('2', 'A1')], lookup);
  assert.deepEqual(kept.map((p) => `${p.nsn}:${p.awardRef}`), ['1:C3', '2:A1']);
});

test('keeps price points from other sources and ones with no matching action', () => {
  const lookup = () => [{ awardUid: 'DIBBS-A1-9', piid: 'A1' }];
  const kept = withoutDuplicatedPricePoints([pp('1', 'A1', 'other_source')], lookup);
  assert.equal(kept.length, 1);
  assert.equal(withoutDuplicatedPricePoints([], lookup).length, 0);
});

test('a non-DIBBS action with a matching piid does not remove a price point', () => {
  const lookup = () => [{ awardUid: 'CONT_AWD_1', piid: 'A1' }];
  assert.equal(withoutDuplicatedPricePoints([pp('1', 'A1')], lookup).length, 1);
});
