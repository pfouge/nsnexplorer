import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_MEANING, calculatorReference, compareToStandard, mapMgmt, mgmtView, priceText, shelfLife, shelfLifeLine, shelfLifeParts, sourceName, standardPrice, unitText } from './nsn-mgmt.ts';
import { mapFlis } from './nsn-flis.ts';

const row = (o: Record<string, unknown> = {}) => ({
  source: 'FLIS', moe_cd: null, effective_date: '2026-07-02', aac: 'D', sos: 'S9C', ui: 'EA', unit_price: 20, qup: '1', ciic: 'U', slc: 'H',
  repairability: null, moe_label: null, aac_label: 'DOD INTEGRATED MATERIEL-MANAGED', sos_label: null, ui_label: 'EACH', ciic_label: null, slc_label: null, ...o,
});

test('shelfLife: Type I letters, Type II digits, 0, non-standard, unknown (DoDM 4140.27 Vol 1 Table 1)', () => {
  assert.deepEqual(shelfLife('A'), { code: 'A', text: '1 month', type: 'I', none: false });
  assert.equal(shelfLife('H')?.text, '12 months (1 year)');
  assert.equal(shelfLife('g')?.text, '9 months');
  assert.equal(shelfLife('Z')?.text, '240 months (20 years)');
  assert.equal(shelfLife('I')?.text, '72 months (6 years)');
  assert.equal(shelfLife('4')?.text, '12 months (1 year)');
  assert.equal(shelfLife('5')?.text, '18 months');
  assert.equal(shelfLife('9')?.text, '60 months (5 years)');
  assert.equal(shelfLife('0')?.none, true);
  assert.equal(shelfLife('V')?.text, 'A period set for this item by its manager');
  assert.equal(shelfLife('X')?.type, 'II');
  assert.equal(shelfLife('K')?.text, '18 months');
  assert.deepEqual(shelfLife('7!'), { code: '7!', text: null, type: null, none: false });
  assert.equal(shelfLife(''), null);
  assert.equal(shelfLife(null), null);
});

test('shelfLifeParts: headline and note', () => {
  assert.deepEqual(shelfLifeParts('M'), { headline: '24 months (2 years)', note: 'Cannot be extended' });
  assert.deepEqual(shelfLifeParts('6'), { headline: '24 months (2 years)', note: 'Can be extended' });
  assert.deepEqual(shelfLifeParts('0'), { headline: 'Not a shelf-life item', note: null });
  assert.deepEqual(shelfLifeParts('Q9'), { headline: 'Q9', note: NO_MEANING });
  assert.deepEqual(shelfLifeParts('Q9', 'Some Label'), { headline: 'Q9', note: 'Some Label' });
  assert.equal(shelfLifeParts(' '), null);
});

test('shelfLifeLine: type wording, bare code for unknown, dictionary label when the table has none', () => {
  assert.equal(shelfLifeLine('H'), '12 months (1 year), cannot be extended');
  assert.equal(shelfLifeLine('2'), '6 months, can be extended');
  assert.equal(shelfLifeLine('0'), 'Not a shelf-life item');
  assert.equal(shelfLifeLine('Q9'), `Q9 (${NO_MEANING})`);
  assert.equal(shelfLifeLine('Q9', 'Some Label'), 'Q9: Some Label');
  assert.equal(shelfLifeLine(null), null);
});

test('mapMgmt: nothing, scope names, MOE kind, label clean-up, price as a number', () => {
  assert.deepEqual(mapMgmt(null).rows, []);
  const m = mapMgmt([
    row(),
    row({ source: 'AIR_FORCE', unit_price: '18.25', slc: null }),
    row({ source: 'FLIS', moe_cd: 'DA', moe_label: 'DEPARTMENT OF THE ARMY' }),
    row({ source: 'FLIS', moe_cd: 'ZC', moe_label: 'CANADA' }),
    row({ source: 'FLIS', moe_cd: 'ZX', moe_label: 'NATO MAINTENANCE AND SUPPLY AGENCY' }),
    row({ source: 'COAST_GUARD', unit_price: null, ui: ' ' }),
  ]);
  assert.deepEqual(m.rows.map((r) => [r.scope, r.kind]), [
    ['Federal catalog (FLIS)', 'us'], ['Air Force', 'us'], ['Department of the Army', 'us'], ['Canada', 'foreign'], ['NATO Maintenance and Supply Agency', 'other'], ['Coast Guard', 'us'],
  ]);
  assert.equal(m.rows[1].unitPrice, 18.25);
  assert.equal(m.rows[5].unitPrice, null);
  assert.equal(m.rows[5].ui, null);
  assert.equal(m.rows[0].aacLabel, 'DoD Integrated Materiel-Managed');
  assert.equal(m.rows[0].effectiveDate, '2026-07-02');
  assert.equal(sourceName('MARINE_CORPS'), 'Marine Corps');
  assert.equal(sourceName('SPACE_FORCE'), 'Space Force');
});

test('standardPrice: catalog row wins; services that agree; services that differ; zero and missing prices', () => {
  assert.equal(standardPrice(mapMgmt([])), null);
  assert.equal(standardPrice(mapMgmt([row({ unit_price: 0 }), row({ source: 'ARMY', unit_price: null })])), null);

  const cat = standardPrice(mapMgmt([row(), row({ source: 'ARMY', unit_price: 18.25 })]))!;
  assert.deepEqual([cat.amount, cat.varies, cat.ui, cat.effectiveDate], [20, false, 'EA', '2026-07-02']);

  const agree = standardPrice(mapMgmt([row({ source: 'ARMY', unit_price: 5 }), row({ source: 'NAVY', unit_price: 5, effective_date: '2026-08-01' })]))!;
  assert.deepEqual([agree.amount, agree.varies, agree.effectiveDate], [5, false, null]); // two dates: no single effective date

  const differ = standardPrice(mapMgmt([row({ source: 'ARMY', unit_price: 5 }), row({ source: 'NAVY', unit_price: 7.5, ui: 'BX' })]))!;
  assert.deepEqual([differ.amount, differ.low, differ.high, differ.varies, differ.ui], [null, 5, 7.5, true, null]);
  assert.equal(priceText(differ), '$5.00 to $7.50 depending on the service');
  assert.equal(priceText(cat), '$20.00 per EA');

  // a priced foreign row never counts
  assert.equal(standardPrice(mapMgmt([row({ moe_cd: 'ZC', unit_price: 99 })])), null);
  // zero in the catalog row, a price in a service row: the service price is used
  assert.equal(standardPrice(mapMgmt([row({ unit_price: 0 }), row({ source: 'ARMY', unit_price: 18.25 })]))!.amount, 18.25);
});

test('unitText: code with meaning when it differs', () => {
  assert.equal(unitText('EA', 'Each'), 'EA (Each)');
  assert.equal(unitText('EA', 'EA'), 'EA');
  assert.equal(unitText('EA', null), 'EA');
  assert.equal(unitText(null, 'Each'), null);
});

test('compareToStandard: percent of the standard price, far-apart reminder, no line without both', () => {
  const std = standardPrice(mapMgmt([row()]))!;
  assert.equal(compareToStandard({ price: 12.4, awardedOn: '2026-05-01' }, std), 'Last award $12.40 is 62% of the standard price $20.00.');
  assert.equal(compareToStandard({ price: 22, awardedOn: '2026-05-01' }, std), 'Last award $22.00 is 110% of the standard price $20.00.');
  assert.match(compareToStandard({ price: 1, awardedOn: '2026-05-01' }, std)!, /5% of the standard price \$20\.00\. The two are far apart, so check that both are for the same unit of issue\.$/);
  assert.match(compareToStandard({ price: 0.05, awardedOn: '2026-05-01' }, std)!, /^Last award \$0\.05 is <1% of/);
  assert.match(compareToStandard({ price: 90, awardedOn: '2026-05-01' }, std)!, /450% of/);
  assert.match(compareToStandard({ price: 300, awardedOn: '2026-05-01' }, std)!, /^Last award \$300\.00 is about 15 times the standard price \$20\.00\. The two are far apart/);
  assert.match(compareToStandard({ price: 72.9, awardedOn: '2026-05-01' }, standardPrice(mapMgmt([row({ unit_price: 0.05 })]))!)!, /about 1,458 times the standard price \$0\.05\./);
  assert.equal(compareToStandard(null, std), null);
  assert.equal(compareToStandard({ price: 12.4, awardedOn: '2026-05-01' }, null), null);
  assert.equal(compareToStandard({ price: 0, awardedOn: '2026-05-01' }, std), null);
  const varies = standardPrice(mapMgmt([row({ source: 'ARMY', unit_price: 5 }), row({ source: 'NAVY', unit_price: 7.5 })]))!;
  assert.equal(compareToStandard({ price: 6, awardedOn: '2026-05-01' }, varies), null);
});

test('mgmtView: one catalog row -> price, shelf life, source of supply, no table', () => {
  const v = mgmtView(mapMgmt([row()]), { price: 12.4, awardedOn: '2026-05-01' });
  assert.equal(v.has, true);
  assert.equal(v.priceLine, '$20.00 per EA');
  assert.equal(v.effectiveLine, 'Jul 2, 2026');
  assert.equal(v.shelfLifeLine, '12 months (1 year), cannot be extended');
  assert.equal(v.sosLine, 'S9C');
  assert.deepEqual(v.table, []);
  assert.equal(v.compare, 'Last award $12.40 is 62% of the standard price $20.00.');
});

test('mgmtView: services differ -> range, mixed flags, compact table; foreign rows hidden', () => {
  const v = mgmtView(
    mapMgmt([
      row({ source: 'ARMY', unit_price: 5, slc: 'H', sos: 'S9C' }),
      row({ source: 'NAVY', unit_price: 7.5, slc: '0', sos: 'N32', sos_label: 'NAVY ICP', aac: null }),
      row({ moe_cd: 'ZC', unit_price: 99 }),
    ]),
    { price: 6, awardedOn: '2026-05-01' }
  );
  assert.equal(v.priceLine, '$5.00 to $7.50 depending on the service');
  assert.equal(v.shelfMixed, true);
  assert.equal(v.shelfLifeLine, null);
  assert.equal(v.sosMixed, true);
  assert.equal(v.hiddenNonUs, 1);
  assert.equal(v.compare, null);
  assert.equal(v.table.length, 2);
  assert.deepEqual(v.table[1], { scope: 'Navy', price: '$7.50', ui: 'EA (Each)', shelfLife: 'Not a shelf-life item', sos: 'N32 (Navy ICP)', aac: '—', effective: 'Jul 2, 2026' });
  assert.equal(v.table[0].aac, 'D (DoD Integrated Materiel-Managed)');
});

test('mgmtView: identical rows give no table; missing price shows shelf life only; unknown codes stay bare', () => {
  const same = mgmtView(mapMgmt([row(), row({ source: 'ARMY' })]));
  assert.deepEqual(same.table, []);
  assert.equal(same.priceLine, '$20.00 per EA');

  const noPrice = mgmtView(mapMgmt([row({ unit_price: 0, slc: 'Q9', aac: 'ZZ', aac_label: null })]));
  assert.equal(noPrice.has, true);
  assert.equal(noPrice.price, null);
  assert.equal(noPrice.priceLine, null);
  assert.equal(noPrice.shelfLifeLine, `Q9 (${NO_MEANING})`);

  const nothing = mgmtView(mapMgmt([row({ unit_price: null, slc: null, sos: null })]));
  assert.equal(nothing.has, false);
  assert.equal(mgmtView(mapMgmt([])).has, false);
});

test('calculatorReference: only with a single standard price', () => {
  assert.deepEqual(calculatorReference(mapMgmt([row()])), { amount: 20, text: '$20.00 per EA' });
  assert.equal(calculatorReference(mapMgmt([row({ source: 'ARMY', unit_price: 5 }), row({ source: 'NAVY', unit_price: 6 })])), null);
  assert.equal(calculatorReference(mapMgmt([])), null);
});

test('mapFlis carries management rows; absent column gives an empty list', () => {
  const base = { flis_ident: null, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] };
  assert.deepEqual(mapFlis(base).management.rows, []);
  assert.equal(mapFlis({ ...base, flis_mgmt: [row()] }).management.rows[0].unitPrice, 20);
});
