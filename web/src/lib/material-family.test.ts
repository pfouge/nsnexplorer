import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyCounts, MATERIAL_FAMILY_LABEL, materialFamily } from './material-family.ts';

test('each family is reachable', () => {
  const cases: [string, string][] = [
    ['STAINLESS STEEL 304', 'stainless'],
    ['STEEL COMP 4340', 'steel'],
    ['CAST IRON', 'steel'],
    ['ACTUATOR ARM ALUMINUM ALLOY 2024', 'aluminum'],
    ['TITANIUM 6AL-4V', 'titanium'],
    ['INCONEL 718', 'nickel'],
    ['BRASS', 'copper'],
    ['SILICONE RUBBER', 'rubber'],
    ['NYLON', 'plastic'],
    ['FIBERGLASS', 'composite'],
    ['LEATHER', 'textile'],
    ['CORK', 'wood'],
    ['MYSTERY ALLOY', 'other'],
  ];
  for (const [raw, fam] of cases) assert.equal(materialFamily(raw), fam, raw);
});

test('precedence and case', () => {
  assert.equal(materialFamily('CARBON STEEL'), 'steel');
  assert.equal(materialFamily('stainless steel'), 'stainless');
  assert.equal(materialFamily('STEEL, CORROSION RESISTING'), 'stainless');
  assert.equal(materialFamily('CRES 316'), 'stainless');
  assert.equal(materialFamily('Aluminum'), 'aluminum');
  assert.equal(materialFamily('CARBON FIBER'), 'composite');
});

test('empty and null', () => {
  assert.equal(materialFamily(null), null);
  assert.equal(materialFamily(undefined), null);
  assert.equal(materialFamily(''), null);
  assert.equal(materialFamily('   '), null);
});

test('counts sort by count then label, other last, zeros omitted', () => {
  const out = familyCounts(['STEEL', 'STEEL', 'ALUMINUM', 'BRASS', 'ZZZ', 'ZZZ', 'ZZZ', null, '']);
  assert.deepEqual(
    out.map((r) => [r.family, r.count]),
    [['steel', 2], ['aluminum', 1], ['copper', 1], ['other', 3]]
  );
  assert.equal(out[0].label, MATERIAL_FAMILY_LABEL.steel);
  assert.deepEqual(familyCounts([null, '']), []);
});
