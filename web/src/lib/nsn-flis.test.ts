import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_DEFINITION, alsoCalled, catalogCells, foreignSummary, hasFlisContent, mapFlis, moeView, stockNumber } from './nsn-flis.ts';

const ident = {
  inc: '67806', crit_cd: 'X', demil: 'A', demil_int_cd: '1', niin_assigned: '1975-10-23', pmic: 'A', adp: '0', hmic: 'P', esd_emi: 'A', hcc: null,
  schedule_b: '8710000090', enac: null, iuid_indicator: null, last_known_sos: null, source_file_date: '2026-10-23',
  pmic_label: 'DOES NOT CONTAIN PRECIOUS METAL', hmic_label: 'NO INFORMATION IN HMIRS', hcc_label: null, enac_label: null, iuid_label: null, sos_label: null,
  schedule_b_text: 'PARTS OF ARMORED FIGHTING VEHICLES,MOTORIZED, WHETHER OR NOT FITTED WITH WEAPONS',
  field_defs: [{ field: 'PMIC', literal: 'PRECIOUS METALS INDICATOR', description: 'PRECIOUS METALS INDICATOR CODE (PMIC):  THIS CODE IS TO IDENTIFY ITEMS THAT HAVE PRECIOUS METALS AS PART OF THEIR CONTENT.' }],
};
const moe = (o: Record<string, unknown>) => ({ moe_rl: 'R', moe_cd: 'DA', moe_label: 'DEPARTMENT OF THE ARMY', amc: '1', amc_label: 'SUITABLE FOR COMPETITIVE ACQUISITION', amsc: 'G', amsc_label: null, aac: null, aac_label: null, imc: 'Z', imc_label: null, pica: 'GX', pica_label: 'HQ DEFENSE LOGISTICS AGENCY ENTERPRISE BUSINESS SYSTEMS', sica: 'CD', sica_label: 'U.S. ARMY WAR RESERVE COMMAND', nimsc: null, assigned_on: '2006-04-01', ...o });

test('mapFlis with nothing returns an empty record', () => {
  const f = mapFlis({ flis_ident: null, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] });
  assert.equal(f.identification, null);
  assert.deepEqual([f.colloquialNames, f.related, f.cancellations, f.moeRules], [[], [], [], []]);
  assert.equal(f.relatedTotal, 0);
  assert.equal(f.cancellationsTotal, 0);
  assert.equal(hasFlisContent(f), false);
  assert.deepEqual(catalogCells(f.identification), []);
  assert.equal(alsoCalled(f), null);
});

test('identification labels are title-cased and schedule B text is sentence case without a period', () => {
  const f = mapFlis({ flis_ident: ident, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] });
  const i = f.identification!;
  assert.equal(i.pmicLabel, 'Does Not Contain Precious Metal');
  assert.equal(i.hmicLabel, 'No Information in HMIRS');
  assert.ok(i.scheduleBText!.startsWith('Parts of armored fighting vehicles, motorized, whether'));
  assert.ok(!i.scheduleBText!.endsWith('.'));
  assert.ok(i.scheduleBText!.length <= 91);
  assert.equal(i.fieldDefinitions[0].name, 'Precious Metals Indicator');
  assert.ok(i.fieldDefinitions[0].text!.startsWith('Precious metals indicator code (PMIC):'));
  assert.equal(i.niinAssigned, '1975-10-23');
});

test('catalogCells: code + meaning, omit empty, flag unknown meanings', () => {
  const cells = catalogCells(mapFlis({ flis_ident: ident, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] }).identification);
  assert.deepEqual(cells.map((c) => c.key), ['assigned', 'demil', 'criticality', 'hazmat', 'precious', 'esd', 'scheduleB']);
  assert.equal(cells[0].value, 'Oct 23, 1975');
  const by = Object.fromEntries(cells.map((c) => [c.key, c]));
  assert.equal(by.demil.value, 'A');
  assert.match(by.demil.meaning!, /no demilitarization needed/);
  assert.equal(by.criticality.value, 'X');
  assert.match(by.criticality.meaning ?? '', /no other critical feature/);
  assert.equal(by.esd.meaning, 'No known ESD or EMI sensitivity');
  assert.equal(by.hazmat.meaning, 'No Information in HMIRS');
  assert.equal(by.scheduleB.value, '8710000090');

  const sparse = mapFlis({ flis_ident: { ...ident, demil: null, crit_cd: null, hmic: null, pmic: null, esd_emi: null, schedule_b: null, niin_assigned: null }, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] });
  assert.deepEqual(catalogCells(sparse.identification), []);
  const unknownDemil = catalogCells(mapFlis({ flis_ident: { ...ident, demil: '7' }, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [] }).identification).find((c) => c.key === 'demil')!;
  assert.deepEqual([unknownDemil.value, unknownDemil.meaning], ['7', null]);
  assert.equal(NO_DEFINITION, 'definition not on file');
});

test('colloquial names: title-cased, de-duplicated, capped at 8', () => {
  const names = ['BOOT,ACTUATOR', 'boot,actuator', 'BOOT,SWITCH', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
  const f = mapFlis({ flis_ident: null, flis_colloquial: names, flis_related: [], flis_cancel: [], flis_moe: [] });
  assert.equal(f.colloquialNames.length, 8);
  assert.equal(f.colloquialNames[0], 'Boot, Actuator');
  assert.equal(alsoCalled(f), f.colloquialNames.join('; '));
});

test('related items and cancellations map dates, links and totals', () => {
  const f = mapFlis({
    flis_ident: null,
    flis_colloquial: [],
    flis_related: [
      { related_nsn: '6240001436681', has_page: false, isc: '3', isc_label: 'ACCEPTED AS NOT AUTHORIZED FOR PROCUREMENT', dec_label: 'DLA AVIATION', stdzn_date: '1990-12-07', total: 2 },
      { related_nsn: '5340002303256', has_page: true, isc: '9', isc_label: null, dec_label: null, stdzn_date: null, total: 2 },
    ],
    flis_cancel: [
      { cancelled_fsc: '5340', cancelled_niin: '015929109', status: '5', status_label: 'CANCELLED-USE', eff_date: '2026-07-22', total: 31 },
      { cancelled_fsc: null, cancelled_niin: '015929110', status: '9', status_label: null, eff_date: null, total: 31 },
    ],
    flis_moe: [],
  });
  assert.equal(f.related[0].relatedNsn, '6240-00-143-6681');
  assert.equal(f.related[0].hasPage, false);
  assert.equal(f.related[0].iscLabel, 'Accepted as Not Authorized for Procurement');
  assert.equal(f.related[1].hasPage, true);
  assert.equal(f.related[1].iscLabel, null);
  assert.equal(f.relatedTotal, 2);
  assert.equal(f.cancellations[0].cancelledNsn, '5340-01-592-9109');
  assert.equal(f.cancellations[0].statusLabel, 'Cancelled-Use');
  assert.equal(f.cancellations[1].cancelledNsn, '01-592-9110');
  assert.equal(f.cancellationsTotal, 31);
  assert.equal(hasFlisContent(f), true);
});

test('stockNumber', () => {
  assert.equal(stockNumber('5340', '015929109'), '5340-01-592-9109');
  assert.equal(stockNumber('53', '015929109'), '01-592-9109');
  assert.equal(stockNumber(null, 'abc'), 'abc');
});

test('moeView: US rows decoded, foreign governments collapse, others kept apart', () => {
  const f = mapFlis({
    flis_ident: null,
    flis_colloquial: [],
    flis_related: [],
    flis_cancel: [],
    flis_moe: [
      moe({ moe_rl: 'A919' }),
      moe({ moe_rl: 'N9BZ', moe_cd: 'DN', moe_label: 'DEPARTMENT OF THE NAVY', sica: 'GX', sica_label: 'X', aac: 'D', aac_label: 'DOD INTEGRATED MATERIEL-MANAGED' }),
      moe({ moe_rl: 'ZH01', moe_cd: 'ZH', moe_label: 'REPUBLIC OF KOREA', amc: null, amc_label: null, amsc: null, pica: 'ZH', pica_label: 'REPUBLIC OF KOREA', sica: null, sica_label: null }),
      moe({ moe_rl: 'YS01', moe_cd: 'YS', moe_label: 'SAUDI ARABIA', amc: null, amsc: null, sica: null }),
      moe({ moe_rl: 'YSSE', moe_cd: 'YS', moe_label: 'SAUDI ARABIA', amc: null, amsc: null, sica: null }),
      moe({ moe_rl: 'ZX01', moe_cd: 'ZX', moe_label: 'NATO MAINTENANCE AND SUPPLY AGENCY', amc: null, amsc: null, sica: null }),
      moe({ moe_rl: 'QQ01', moe_cd: 'QQ', moe_label: null, amc: null, amsc: null }),
    ],
  });
  const v = moeView(f.moeRules);
  assert.equal(v.us.length, 3, 'DA, DN and the unlabeled Q* code are US');
  assert.equal(v.us[0].service, 'Department of the Army');
  assert.equal(v.us[0].manager, 'HQ Defense Logistics Agency Enterprise Business Systems');
  assert.equal(v.us[0].retail, 'U.S. Army War Reserve Command');
  assert.equal(v.us[1].aacLabel, 'DoD Integrated Materiel-Managed');
  assert.equal(v.us[2].service, 'QQ');
  assert.deepEqual(v.foreignNames, ['Republic of Korea', 'Saudi Arabia']);
  assert.deepEqual(v.otherNames, ['NATO Maintenance and Supply Agency']);
  assert.equal(foreignSummary(v), 'Also registered by 2 other governments and 1 other organization');
});

test('moeView: retail manager hidden when SICA equals PICA; no foreign summary when none', () => {
  const f = mapFlis({ flis_ident: null, flis_colloquial: [], flis_related: [], flis_cancel: [], flis_moe: [moe({ sica: 'GX', sica_label: 'SAME' })] });
  const v = moeView(f.moeRules);
  assert.equal(v.us[0].retail, null);
  assert.equal(foreignSummary(v), null);
  assert.equal(foreignSummary({ us: [], foreignNames: ['Japan'], otherNames: [] }), 'Also registered by 1 other government');
});
