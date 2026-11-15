import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  CEILING_LABEL,
  CEILING_PRICE_POINT_SQL,
  CONTRACT_CEILING_SQL,
  NOT_CONTRACT_CEILING_SQL,
  ceilingAmountText,
  ceilingPricePointSql,
  contractCeilingSql,
  isCeilingPricePoint,
  isContractCeiling,
} from './contract-ceiling.ts';
import * as mjs from '../../../shared/contract-ceiling.mjs';

const uid = (piid: string, extra = '') => `DIBBS-${piid}${extra}`;

test('base awards of type D, G and A with no delivery order are ceilings', () => {
  assert.equal(isContractCeiling(uid('SPE7L127D0123'), 'SPE7L127D0123', null), true);
  assert.equal(isContractCeiling(uid('SPE7L127G0123'), 'SPE7L127G0123', undefined), true);
  assert.equal(isContractCeiling(uid('SPE7L127A0123'), 'SPE7L127A0123', ''), true);
  assert.equal(isContractCeiling(uid('SPE7L127D0123', '-7018620303'), 'SPE7L127D0123', '   '), true);
  assert.equal(isContractCeiling(uid('SPE7L127d0123'), 'SPE7L127d0123', null), true, 'lower case type');
});

test('a delivery order row is a real purchase', () => {
  assert.equal(isContractCeiling(uid('SPE7L127D0123-0005'), 'SPE7L127D0123/0005', '0005'), false);
  assert.equal(isContractCeiling(uid('SPE7L127G0123-0005'), 'SPE7L127G0123/0005', 5), false);
});

test('P, V, C and M awards with no delivery order keep counting', () => {
  for (const t of ['P', 'V', 'C', 'M']) {
    const piid = `SPE7L127${t}0123`;
    assert.equal(isContractCeiling(uid(piid), piid, null), false, t);
  }
});

test('USAspending rows and malformed input are never ceilings', () => {
  assert.equal(isContractCeiling('CONT_AWD_SPE7L127D0123_9700', 'SPE7L127D0123', null), false);
  assert.equal(isContractCeiling(null, 'SPE7L127D0123', null), false);
  assert.equal(isContractCeiling(uid('X'), null, null), false);
  assert.equal(isContractCeiling(uid('SHORT'), 'SHORT', null), false);
  assert.equal(isContractCeiling(uid('SPE7L127D0123'), '', null), false);
});

test('price points: dibbs_award, D/G/A at the 9th character, no dash', () => {
  assert.equal(isCeilingPricePoint('dibbs_award', 'SPE7L427D60HM'), true);
  assert.equal(isCeilingPricePoint('dibbs_award', 'SPE7L427G60HM'), true);
  assert.equal(isCeilingPricePoint('dibbs_award', 'SPE7L427D60HM-0001'), false);
  assert.equal(isCeilingPricePoint('dibbs_award', 'SPE7L427V60HM'), false);
  assert.equal(isCeilingPricePoint('dibbs_award', 'SPE7L4'), false);
  assert.equal(isCeilingPricePoint('other', 'SPE7L427D60HM'), false);
  assert.equal(isCeilingPricePoint(null, null), false);
});

test('wording', () => {
  assert.equal(ceilingAmountText('$350,000'), 'up to $350,000 ceiling');
  assert.equal(CEILING_LABEL, 'Long-term contract');
  assert.ok(!/—/.test(ceilingAmountText('$1') + CEILING_LABEL), 'no em dash');
});

test('SQL fragments name the same rule and use the alias', () => {
  assert.match(CONTRACT_CEILING_SQL, /ca\.award_uid LIKE 'DIBBS-%'/);
  assert.match(CONTRACT_CEILING_SQL, /substr\(ca\.piid, 9, 1\)\) IN \('D', 'G', 'A'\)/);
  assert.match(CONTRACT_CEILING_SQL, /deliveryOrder/);
  assert.equal(NOT_CONTRACT_CEILING_SQL, `NOT ${CONTRACT_CEILING_SQL}`);
  assert.match(contractCeilingSql('c'), /c\.piid/);
  assert.ok(!contractCeilingSql('c').includes('ca.'));
  assert.match(ceilingPricePointSql('x'), /x\.award_ref/);
});

test('the plain-Node copy in shared/contract-ceiling.mjs produces identical SQL', () => {
  assert.equal(mjs.CONTRACT_CEILING_SQL, CONTRACT_CEILING_SQL);
  assert.equal(mjs.NOT_CONTRACT_CEILING_SQL, NOT_CONTRACT_CEILING_SQL);
  assert.equal(mjs.contractCeilingSql('c'), contractCeilingSql('c'));
  assert.equal(mjs.ceilingPricePointSql('p'), ceilingPricePointSql('p'));
  assert.equal(mjs.CEILING_PRICE_POINT_SQL, CEILING_PRICE_POINT_SQL);
});

test('migration 0015 spells out the same rules, for the aliases it uses', () => {
  const sql = readFileSync(new URL('../../../db/migrations/0015_contract_ceilings.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(`not ${ceilingPricePointSql('q')}`), 'watch functions, price points (alias q)');
  assert.ok(sql.includes(`not ${contractCeilingSql('q')}`), 'watch functions, contract actions (alias q)');
  assert.ok(sql.includes(`NOT ${ceilingPricePointSql('pp')}`), 'refresh_supplier_stats (alias pp)');
  // No other table reference may remain unfiltered.
  const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.equal(code.match(/pub\.price_points(?! q)/g)?.length, 1, 'only refresh_supplier_stats reads pub.price_points directly');
  assert.equal(code.match(/pub\.contract_actions(?! q)/g)?.length ?? 0, 0, 'every pub.contract_actions read is filtered');
});
