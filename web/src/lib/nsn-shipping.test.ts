import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HMC_NONE, codeText, decodeCode, decodeMeaning, formatNumber, ltlMeaning, mapShipping, pickPackaging, shippingView } from './nsn-shipping.ts';
import { mapFlis } from './nsn-flis.ts';

const def = (literal: string | null, description: string | null) => ({ literal, description });
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

// Real dictionary rows (code, literal, description).
const SPC_00 = def('NUMERIC', 'NO SPECIAL MARKING.');
const SPC_01 = def('NUMERIC', 'FRAGILE.');
const SPC_ZZ = def('SPECIAL REQUIREMENTS', 'SPECIAL REQUIREMENTS.');
const UCL_A = def('LEVEL A PACKING PROTECTION', 'UNIT CONTAINER PROVIDES LEVEL A PACKING PROTECTION.');
const LVL_Q = def('TABLE C.II', 'PACKING SHALL BE ACCOMPLISHED IN ACCORDANCE WITH TABLE C.II FOR THE PACKING LEVEL SPECIFIED. CLOSURE, SEALING AND REINFORCEMENT ...');
const LVL_F = def('PACKING IS NOT REQUIRED', 'PACKING IS NOT REQUIRED. THE UNIT CONTAINER SHALL ALSO SERVE AS THE SHIPPING CONTAINER.');
const MOP_10 = def('NUMERIC', 'PHYSICAL PROTECTION.');
const PKG_27 = def('POSITIONS 1 AND 2', 'PLATED COATED ITEMS. NON-FERROUS METALS THAT HAVE BEEN PLATED. METHOD OF PRESERVATION 10. IF COMBINED WITH A N...');
const PKG_01 = def('NUMERIC-POSITIONS 1 AND 2', 'BARE METAL ITEMS. IRON, STEEL (BARE OR BLACK OXIDE COATED); ...');
const LTL_M = def('85.0', '85.0');
const LTL_W = def('RATING VARIABLE', 'RATING VARIABLE');

test('formatNumber trims trailing zeros and caps at four decimals', () => {
  assert.equal(formatNumber(1.5), '1.5');
  assert.equal(formatNumber(1), '1');
  assert.equal(formatNumber(0.007), '0.007');
  assert.equal(formatNumber(63.3), '63.3');
  assert.equal(formatNumber(165.649), '165.649');
  assert.equal(formatNumber(1.23456789), '1.2346');
  assert.equal(formatNumber(1350), '1,350');
});

test('decodeMeaning: humanized literal unless the literal is a placeholder, then the first sentence of the description', () => {
  assert.equal(decodeMeaning('LEVEL A PACKING PROTECTION', 'UNIT CONTAINER PROVIDES LEVEL A PACKING PROTECTION.'), 'Level A Packing Protection');
  assert.equal(decodeMeaning('TABLE C.II', 'PACKING SHALL BE ...'), 'Table C.II');
  assert.equal(decodeMeaning('NUMERIC', 'NO SPECIAL MARKING.'), 'No special marking');
  assert.equal(decodeMeaning('NUMERIC', 'FRAGILE.'), 'Fragile');
  assert.equal(decodeMeaning('NUMERIC-POSITIONS 1 AND 2', 'BARE METAL ITEMS. IRON, STEEL (BARE OR BLACK OXIDE COATED); ...'), 'Bare metal items');
  assert.equal(decodeMeaning('POSITIONS 1 AND 2', 'PLATED COATED ITEMS. NON-FERROUS METALS THAT HAVE BEEN PLATED.'), 'Plated coated items');
  assert.equal(decodeMeaning('POSITION 4', 'THE FOURTH POSITION IS A LETTER.'), 'The fourth position is a letter');
  assert.equal(decodeMeaning('numeric', 'Fragile.'), 'Fragile');
  assert.equal(decodeMeaning('ESD SENSITIVE', 'ESD SENSITIVE ELECTRONIC DEVICE REQUIREMENTS OF MIL-STD-129 APPLY.'), 'ESD Sensitive');
  assert.equal(decodeMeaning('NUMERIC', null), null);
  assert.equal(decodeMeaning(null, null), null);
  assert.equal(decodeMeaning(null, 'KEEP DRY.'), 'Keep dry');
});

test('decodeMeaning caps a long first sentence', () => {
  const long = `${'WORD '.repeat(80)}END.`;
  const m = decodeMeaning('NUMERIC', long)!;
  assert.ok(m.length <= 141, String(m.length));
});

test('decodeCode: no dictionary row means the code stands alone, never an invented meaning', () => {
  assert.deepEqual(decodeCode('SHC', 'K', null), { field: 'SHC', code: 'K', decodedPart: null, literal: null, description: null, meaning: null });
  assert.equal(decodeCode('SHC', ' ', null), null);
  assert.equal(decodeCode('SHC', null, undefined), null);
  const d = decodeCode('SPC_MKG', '01', SPC_01)!;
  assert.deepEqual([d.code, d.literal, d.description, d.meaning], ['01', 'NUMERIC', 'FRAGILE.', 'Fragile']);
  assert.equal(codeText(d), 'Fragile (code 01)');
  assert.equal(decodeCode('SPC_MKG', '00', SPC_00)!.meaning, 'No special marking');
  assert.equal(decodeCode('SPC_MKG', 'ZZ', SPC_ZZ)!.meaning, 'Special Requirements');
  assert.equal(codeText(decodeCode('SHC', 'K', null)!), 'Code K');
  // a dictionary row with a placeholder literal and no description has no usable text
  assert.equal(decodeCode('MOP', '10', def('NUMERIC', null))!.meaning, null);
});

test('LTL: numeric literals read as a class, others are humanized', () => {
  assert.equal(ltlMeaning('85.0', '85.0'), 'Class 85');
  assert.equal(ltlMeaning('100.0', '100.0'), 'Class 100');
  assert.equal(ltlMeaning('92.5', '92.5'), 'Class 92.5');
  assert.equal(ltlMeaning('RATING VARIABLE', 'RATING VARIABLE'), 'Rating Variable');
  assert.equal(ltlMeaning('NO RATING', 'NO RATING'), 'No Rating');
  assert.equal(codeText(decodeCode('LTL', 'M', LTL_M)!), 'Class 85 (code M)');
  assert.equal(codeText(decodeCode('LTL', 'W', LTL_W)!), 'Rating Variable (code W)');
  assert.equal(codeText(decodeCode('LTL', 'Q', null)!), 'Code Q');
});

const pkgRow = (o: Record<string, unknown> = {}) => ({
  pica_sica: 'P', pkg_cat: null, unpkg_item_weight: null, unpkg_item_width: null, unpkg_item_length: null, unpkg_item_height: null,
  mop: null, spc_mkg: null, ucl: null, lvl_a: null, lvl_b: null, lvl_c: null, unit_pack_weight: null, up_sz_maxb: null, up_sz_maxl: null,
  up_sz_maxh: null, unit_pack_cube: null, supplemental_instructions: null, spi_no: null, spi_rev: null, ...o,
});
const frRow = (o: Record<string, unknown> = {}) => ({ nmfc: null, nmfc_sub: null, nmf_desc: null, hmc: null, ltl: null, tcc: null, shc: null, ...o });

test('mapShipping decodes every code and keeps raw values, treating 0 as not recorded', () => {
  const s = mapShipping(
    [pkgRow({ pkg_cat: '27B0', pkg_cat_def: PKG_27, mop: '10', mop_def: MOP_10, spc_mkg: '01', spc_mkg_def: SPC_01, ucl: 'A', ucl_def: UCL_A, lvl_a: 'Q', lvl_a_def: LVL_Q, lvl_b: 'F', lvl_b_def: LVL_F, lvl_c: 'E',
      unit_pack_weight: '1.5000', unit_pack_cube: 0.007, up_sz_maxl: 95, up_sz_maxb: 63.3, up_sz_maxh: 0, unpkg_item_weight: 0 })],
    frRow({ nmfc: '128000', ltl: 'M', ltl_def: LTL_M })
  );
  const p = s.packaging[0];
  assert.equal(p.pkgCat!.code, '27B0');
  assert.equal(p.pkgCat!.decodedPart, '27');
  assert.equal(p.pkgCat!.meaning, 'Plated coated items');
  assert.equal(p.mop!.meaning, 'Physical protection');
  assert.equal(p.lvlC!.meaning, null);
  assert.equal(p.lvlC!.code, 'E');
  assert.equal(p.unitPackWeight, 1.5);
  assert.equal(p.upSzMaxH, null);
  assert.equal(p.unpkgItemWeight, null);
  assert.equal(s.freight!.ltl!.meaning, 'Class 85');
  assert.deepEqual(mapShipping(null, null), { packaging: [], freight: null });
  assert.deepEqual(mapShipping(undefined, undefined), { packaging: [], freight: null });
});

test('PKG_CAT: only the first two characters are decoded; no row for them shows the code alone', () => {
  const s = mapShipping([pkgRow({ pkg_cat: '27B0', pkg_cat_def: PKG_27 })], null);
  const v = shippingView(s);
  const r = v.rows.find((x) => x.key === 'pkgCat')!;
  assert.deepEqual(r.lines, ['Plated coated items (code 27B0)']);
  assert.equal(r.note, 'The meaning is for the first two characters (27).');
  const none = shippingView(mapShipping([pkgRow({ pkg_cat: '69Z0', pkg_cat_def: null })], null)).rows[0];
  assert.deepEqual(none.lines, ['Code 69Z0']);
  assert.equal(none.note, null);
  const numeric = shippingView(mapShipping([pkgRow({ pkg_cat: '01A9', pkg_cat_def: PKG_01 })], null)).rows[0];
  assert.deepEqual(numeric.lines, ['Bare metal items (code 01A9)']);
});

test('shippingView: pack and item measures, formatted without trailing zeros', () => {
  const v = shippingView(mapShipping([pkgRow({
    unit_pack_weight: 1350, unit_pack_cube: 165.649, up_sz_maxl: 95, up_sz_maxb: 63.3, up_sz_maxh: 47.6,
    unpkg_item_weight: 1, unpkg_item_length: 7.5, unpkg_item_width: 5, unpkg_item_height: 1.5,
  })], null));
  const by = Object.fromEntries(v.rows.map((r) => [r.key, r.lines.join('|')]));
  assert.equal(by.unitPackWeight, '1,350 lb');
  assert.equal(by.unitPackCube, '165.649 cu ft');
  assert.equal(by.unitPackSize, '95 x 63.3 x 47.6 in (length x width x height)');
  assert.equal(by.unpkgWeight, '1 lb');
  assert.equal(by.unpkgSize, '7.5 x 5 x 1.5 in (length x width x height)');
  assert.equal(v.hasMeasures, true);
  assert.deepEqual(v.rows.map((r) => r.key), ['unitPackWeight', 'unitPackCube', 'unitPackSize', 'unpkgWeight', 'unpkgSize']);
});

test('shippingView: a size needs all three dimensions', () => {
  const v = shippingView(mapShipping([pkgRow({ unit_pack_weight: 2, up_sz_maxl: 95, up_sz_maxb: 63.3, unpkg_item_length: 1, unpkg_item_width: 2 })], null));
  assert.deepEqual(v.rows.map((r) => r.key), ['unitPackWeight']);
});

test('shippingView: packing levels, container level, marking, SPI and supplemental text', () => {
  const v = shippingView(mapShipping([pkgRow({
    lvl_a: 'Q', lvl_a_def: LVL_Q, lvl_b: 'F', lvl_b_def: LVL_F, lvl_c: 'Z', ucl: 'A', ucl_def: UCL_A,
    spc_mkg: '01', spc_mkg_def: SPC_01, mop: '10', mop_def: MOP_10, spi_no: 'F004546662', spi_rev: 'D', supplemental_instructions: 'IP056: MERCURY OR MERCURY',
  })], null));
  const by = Object.fromEntries(v.rows.map((r) => [r.key, r.lines]));
  assert.deepEqual(by.levels, ['Level A: Table C.II (code Q)', 'Level B: Packing Is Not Required (code F)', 'Level C: code Z']);
  assert.deepEqual(by.ucl, ['Level A Packing Protection (code A)']);
  assert.deepEqual(by.spcMkg, ['Fragile (code 01)']);
  assert.deepEqual(by.mop, ['Physical protection (code 10)']);
  assert.deepEqual(by.spi, ['F004546662, revision D']);
  assert.deepEqual(by.supplemental, ['IP056: MERCURY OR MERCURY']);
  assert.equal(v.hasMeasures, false);
  const noRev = shippingView(mapShipping([pkgRow({ spi_no: 'AM12529566' })], null));
  assert.deepEqual(noRev.rows[0].lines, ['AM12529566']);
  const noSpi = shippingView(mapShipping([pkgRow({ spi_rev: 'D' })], null));
  assert.equal(noSpi.has, false);
});

test('shippingView: freight class with sub item and description, LTL, cargo and handling', () => {
  const v = shippingView(mapShipping([], frRow({ nmfc: '128000', nmfc_sub: 'X', nmf_desc: 'ENGINES, INTERNAL COMBUSTION, NOI', ltl: 'M', ltl_def: LTL_M, tcc: 'Z', tcc_def: def('GENERAL FREIGHT', null), shc: '9' })));
  const by = Object.fromEntries(v.rows.map((r) => [r.key, r.lines]));
  assert.deepEqual(by.nmfc, ['Item 128000, sub X', 'ENGINES, INTERNAL COMBUSTION, NOI']);
  assert.deepEqual(by.ltl, ['Class 85 (code M)']);
  assert.deepEqual(by.tcc, ['General Freight (code Z)']);
  assert.deepEqual(by.shc, ['Code 9']);
  const noSub = shippingView(mapShipping([], frRow({ nmfc: '118100' })));
  assert.deepEqual(noSub.rows[0].lines, ['Item 118100']);
});

test('hazardous material: decoded, or "None on file" when there is a freight row and the code is blank', () => {
  const some = shippingView(mapShipping([], frRow({ hmc: 'AA', hmc_def: def('AMMUNITION FOR CANNON WITH EMPTY PROJECT', 'AMMUNITION FOR CANNON WITH EMPTY PROJECT') })));
  assert.deepEqual(some.rows.find((r) => r.key === 'hmc')!.lines, ['Ammunition for Cannon with Empty Project (code AA)']);
  const none = shippingView(mapShipping([], frRow({ ltl: 'W', ltl_def: LTL_W })));
  assert.deepEqual(none.rows.find((r) => r.key === 'hmc')!.lines, [HMC_NONE]);
  assert.equal(HMC_NONE, 'None on file');
  // packaging only: no hazardous material row at all
  const packOnly = shippingView(mapShipping([pkgRow({ unit_pack_weight: 1 })], null));
  assert.equal(packOnly.rows.some((r) => r.key === 'hmc'), false);
});

test('pickPackaging: the P row wins, else the S row, else none', () => {
  const both = mapShipping([pkgRow({ pica_sica: 'S', unit_pack_weight: 9 }), pkgRow({ pica_sica: 'P', unit_pack_weight: 1 })], null);
  assert.equal(pickPackaging(both.packaging)!.picaSica, 'P');
  const v = shippingView(both);
  assert.equal(v.packagingFrom, 'P');
  assert.deepEqual(v.rows[0].lines, ['1 lb']);
  const sOnly = shippingView(mapShipping([pkgRow({ pica_sica: 'S', unit_pack_weight: 9 })], null));
  assert.equal(sOnly.packagingFrom, 'S');
  assert.deepEqual(sOnly.rows[0].lines, ['9 lb']);
  assert.equal(pickPackaging([]), null);
  assert.equal(pickPackaging(mapShipping([pkgRow({ pica_sica: '', unit_pack_weight: 3 })], null).packaging), null);
});

test('the block is hidden when there is nothing to show', () => {
  assert.equal(shippingView(mapShipping([], null)).has, false);
  assert.equal(shippingView(mapShipping([pkgRow()], null)).has, false);
  assert.equal(shippingView(mapShipping(undefined, undefined)).rows.length, 0);
  // a freight row always shows at least the hazardous material line
  assert.equal(shippingView(mapShipping([], frRow())).has, true);
});

test('mapFlis carries the shipping record', () => {
  const f = mapFlis({ flis_ident: null, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [], flis_mgmt: [], flis_packaging: [pkgRow({ unit_pack_weight: 2 })], flis_freight: frRow({ nmfc: '1' }) });
  assert.equal(f.shipping.packaging[0].unitPackWeight, 2);
  assert.equal(f.shipping.freight!.nmfc, '1');
  assert.deepEqual(mapFlis({}).shipping, { packaging: [], freight: null });
});

test('a long unbroken supplemental text and SPI number pass through whole (the page wraps them)', () => {
  const long = 'X'.repeat(300);
  const v = shippingView(mapShipping([pkgRow({ supplemental_instructions: long, spi_no: 'AM' + 'Z'.repeat(60) })], null));
  assert.equal(v.rows.find((r) => r.key === 'supplemental')!.lines[0], long);
  assert.equal(v.rows.find((r) => r.key === 'spi')!.lines[0].length, 62);
});

test('no em-dash or en-dash in any copy the view produces', () => {
  const s = mapShipping(
    [pkgRow({ pkg_cat: '27B0', pkg_cat_def: PKG_27, mop: '10', mop_def: MOP_10, spc_mkg: 'ZZ', spc_mkg_def: SPC_ZZ, ucl: 'A', ucl_def: UCL_A, lvl_a: 'Q', lvl_a_def: LVL_Q, spc_mkg_x: 1,
      unit_pack_weight: 1.5, unit_pack_cube: 0.007, up_sz_maxl: 1, up_sz_maxb: 2, up_sz_maxh: 3, spi_no: 'F1', spi_rev: 'D', supplemental_instructions: 'A B' })],
    frRow({ nmfc: '1', nmfc_sub: 'Z', nmf_desc: 'D', ltl: 'W', ltl_def: LTL_W })
  );
  const text = JSON.stringify(shippingView(s));
  assert.ok(!text.includes(EM) && !text.includes(EN));
});
