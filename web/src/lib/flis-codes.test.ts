import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRITICALITY_CODES,
  DEMIL_CODES,
  ESD_EMI_CODES,
  cleanDefinition,
  criticalityMeaning,
  demilMeaning,
  esdEmiMeaning,
  humanizeLabel,
  moeKind,
} from './flis-codes.ts';

test('DEMIL table covers exactly the codes read from DoDM 4160.28 Vol 2 Table 1', () => {
  assert.deepEqual(Object.keys(DEMIL_CODES).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'P', 'Q']);
  for (const v of Object.values(DEMIL_CODES)) assert.ok(v.length > 8 && v.length < 100, v);
  assert.match(demilMeaning('a')!, /no demilitarization needed/);
  assert.equal(demilMeaning(' Q ')!.startsWith('Commerce Control List'), true);
});

test('unknown or empty codes are unlabeled, never guessed', () => {
  assert.equal(demilMeaning('1'), null);
  assert.equal(demilMeaning(null), null);
  assert.equal(demilMeaning(''), null);
  assert.equal(esdEmiMeaning('Z'), null);
  assert.match(criticalityMeaning('X') ?? '', /no other critical feature/);
  assert.equal(criticalityMeaning('V'), null);
  assert.deepEqual(Object.keys(CRITICALITY_CODES), ['C', 'E', 'F', 'N', 'X', 'Y']);
});

test('ESD/EMI table is Table 189 A-D', () => {
  assert.deepEqual(Object.keys(ESD_EMI_CODES), ['A', 'B', 'C', 'D']);
  assert.equal(esdEmiMeaning('A'), 'No known ESD or EMI sensitivity');
  assert.equal(esdEmiMeaning('d'), 'Sensitive to both ESD and EMI');
});

test('humanizeLabel title-cases dictionary literals and keeps acronyms', () => {
  assert.equal(humanizeLabel('DEPARTMENT OF THE ARMY'), 'Department of the Army');
  assert.equal(humanizeLabel('U.S. MARINE CORPS'), 'U.S. Marine Corps');
  assert.equal(humanizeLabel('HQ UNITED STATES SPECIAL OPERATIONS COMMAND'), 'HQ United States Special Operations Command');
  assert.equal(humanizeLabel('NAVAL INVENTORY CONTROL POINT'), 'Naval Inventory Control Point');
  assert.equal(humanizeLabel('CANCELLED-USE'), 'Cancelled-Use');
  assert.equal(humanizeLabel('NATO MAINTENANCE AND SUPPLY AGENCY'), 'NATO Maintenance and Supply Agency');
  assert.equal(humanizeLabel('Already Mixed'), 'Already Mixed');
  assert.equal(humanizeLabel('  '), null);
  assert.equal(humanizeLabel(null), null);
});

test('humanizeLabel keeps table references, ASTM and a letter after LEVEL or CLASS', () => {
  assert.equal(humanizeLabel('TABLE C.II'), 'Table C.II');
  assert.equal(humanizeLabel('REQUIREMENTS OF ASTM-D4169'), 'Requirements of ASTM-D4169');
  assert.equal(humanizeLabel('LEVEL A PACKING PROTECTION'), 'Level A Packing Protection');
  assert.equal(humanizeLabel('CLASS B ITEM'), 'Class B Item');
  assert.equal(humanizeLabel('PACKED IN A BOX'), 'Packed in a Box');
});

test('cleanDefinition strips boilerplate, sentence-cases and trims', () => {
  const isc =
    'ITEM STANDARDIZATION CODE (ISC):  THE CODED REPRESENTATION OF THE ITEM STANDARDIZATION DECISION ON INDIVIDUAL ITEMS. DECISIONS ARE BASED ON THE RULES AND PROCEDURES ESTABLISHED IN THE DEPARTMENT OF DEFENSE STANDARDIZATION MANUAL 4120.24-M.  SEE VOLUME 10, TABLES 91 AND 92 AND QUICK INFO ON-LINE.4120.24-M.  SEE VOLUME 10, TABLES 91 AND 92 AND QUICK INFO ON-LINE.';
  const out = cleanDefinition(isc)!;
  assert.ok(out.length <= 200, String(out.length));
  assert.ok(out.startsWith('Item standardization code (ISC): the coded representation'), out);
  assert.ok(!/SEE VOLUME|QUICK INFO/i.test(out));
  assert.equal(cleanDefinition('~~~~~~~~~~~JORDAN', 50), 'Jordan.');
  assert.equal(cleanDefinition('A CODE. SEE VOLUME 10, TABLE 1.'), 'A code.');
  assert.equal(cleanDefinition(null), null);
  assert.equal(cleanDefinition('   '), null);
  const long = cleanDefinition('WORD '.repeat(100), 60)!;
  assert.ok(long.length <= 60 && long.endsWith('…'), long);
});

test('cleanDefinition removes URLs, DRN boilerplate and keeps acronyms', () => {
  const out = cleanDefinition('ACQUISITION METHOD CODE: A CODE REFLECTING THE DECISION OF THE PRIMARY INVENTORY CONTROL ACTIVITY /PICA/. MUST BE USED IN COMBINATION WITH DRN 2876. SEE VOLUME 10, TABLES 70 AND 71.')!;
  assert.ok(!/DRN 2876/.test(out), out);
  assert.ok(/PICA/.test(out), out);
  assert.ok(!/https?:/i.test(cleanDefinition('SEE https://x.example/a.docx FOR MORE')!));
});

test('moeKind: US agencies, foreign governments, and the ones treated as other', () => {
  for (const c of ['DA', 'DF', 'DM', 'DN', 'DS', 'DJ', 'GP', 'TG', 'T1', 'VA', 'KP', 'da']) assert.equal(moeKind(c), 'us', c);
  for (const c of ['ZH', 'ZK', 'ZA', 'YS', 'YD', 'WP', 'WZ', 'VJ', 'VK', 'IB', 'O2']) assert.equal(moeKind(c), 'foreign', c);
  for (const c of ['ZX', 'KA', '', 'D', 'DAA', null, undefined, 'N1', 'P2', 'J1']) assert.equal(moeKind(c as string), 'other', String(c));
});
