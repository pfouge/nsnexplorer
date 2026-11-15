import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSIST_QUICK_SEARCH_URL,
  assistUrl,
  collectStandardDocs,
  extractStandardRefs,
  standardActionLabel,
  standardAvailability,
  standardFromPartNumber,
  suffixSentence,
} from './standard-refs.ts';

const ids = (t: string) => extractStandardRefs(t).map((r) => r.id);
const one = (t: string) => {
  const r = extractStandardRefs(t);
  assert.equal(r.length, 1, `expected one ref in ${JSON.stringify(t)}, got ${JSON.stringify(r.map((x) => x.id))}`);
  return r[0];
};

test('MIL specifications: id without revision, family and access', () => {
  const a = one('MIL-DTL-25988C');
  assert.equal(a.id, 'MIL-DTL-25988');
  assert.equal(a.revision, 'C');
  assert.equal(a.family, 'MIL-DTL');
  assert.equal(a.access, 'assist');
  assert.equal(a.publisher, null);
  assert.equal(one('MIL-PRF-81322G').family, 'MIL-PRF');
  assert.equal(one('MIL-STD-130N').family, 'MIL-STD');
  assert.equal(one('MIL-HDBK-5J').family, 'MIL-HDBK');
  assert.equal(one('MIL-S-8879').family, 'MIL');
  assert.equal(one('MIL-S-8879').id, 'MIL-S-8879');
  assert.equal(one('DOD-STD-100').family, 'DOD');
});

test('MIL slash sheets keep the sheet in the id and the revision of the sheet', () => {
  const r = one('MIL-DTL-83513/01G');
  assert.equal(r.id, 'MIL-DTL-83513/01');
  assert.equal(r.revision, 'G');
});

test('FLIS reply with a CAGE prefix: 81349-MIL-DTL-25988 CLASS 1', () => {
  const r = one('81349-MIL-DTL-25988 CLASS 1');
  assert.equal(r.id, 'MIL-DTL-25988');
  assert.equal(r.access, 'assist');
});

test('federal specifications and commercial item descriptions are government documents', () => {
  const f = one('FF-W-84');
  assert.deepEqual([f.family, f.access, f.id], ['FED', 'assist', 'FF-W-84']);
  assert.equal(one('QQ-A-250/4').id, 'QQ-A-250/4');
  assert.equal(one('ZZ-R-765').family, 'FED');
  const c = one('A-A-59326');
  assert.deepEqual([c.family, c.access, c.what], ['CID', 'assist', 'Commercial item description']);
  assert.equal(one('A-A-52480B').revision, 'B');
});

test('MS sheet with dash number in text and as a part number', () => {
  const r = one('MS35338-44');
  assert.deepEqual([r.id, r.suffix, r.suffixStyle, r.access, r.family], ['MS35338', '44', 'dash', 'assist', 'MS']);
  const multi = one('MS3367-7-9');
  assert.deepEqual([multi.id, multi.suffix], ['MS3367', '7-9']);
  const code = one('MS21042L3');
  assert.deepEqual([code.id, code.suffix, code.suffixStyle], ['MS21042', 'L3', 'code']);
});

test('MS digits without separator: five-digit sheet number, split flagged as inferred', () => {
  const r = one('MS35338144');
  assert.deepEqual([r.id, r.suffix, r.inferred], ['MS35338', '144', true]);
  assert.equal(one('MS35338').inferred, false);
  assert.equal(one('MS35338').suffix, null);
});

test('AN sheets: dash number and letter codes', () => {
  const a = one('AN960-10');
  assert.deepEqual([a.id, a.suffix, a.suffixStyle, a.access], ['AN960', '10', 'dash', 'assist']);
  const b = one('AN960C10');
  assert.deepEqual([b.id, b.suffix, b.suffixStyle], ['AN960', 'C10', 'code']);
  const c = one('AN3H5A');
  assert.deepEqual([c.id, c.suffix], ['AN3', 'H5A']);
  assert.equal(one('AN960-10L').suffix, '10L');
});

test('"AN" in prose is not a standard', () => {
  assert.deepEqual(ids('USED ON AN ENGINE, AN 5 UNIT KIT'), []);
  assert.deepEqual(ids('AN INCH LONG'), []);
});

test('NAS and NASM: industry standards sold by AIA, no ASSIST link', () => {
  const n = one('NAS1352-4-6');
  assert.deepEqual([n.id, n.suffix, n.access, n.publisher], ['NAS1352', '4-6', 'sold', 'AIA']);
  assert.equal(one('NAS514P428').suffix, 'P428');
  const m = one('NASM1312-8');
  assert.deepEqual([m.id, m.family, m.publisher, m.access], ['NASM1312', 'NASM', 'AIA', 'sold']);
  assert.equal(one('NAM2000').family, 'NASM');
});

test('SAE documents: AS, AMS, SAE J are sold by SAE', () => {
  const as = one('AS568-214');
  assert.deepEqual([as.id, as.suffix, as.publisher, as.access], ['AS568', '214', 'SAE', 'sold']);
  const ams = one('AMS7276');
  assert.deepEqual([ams.id, ams.publisher, ams.access], ['AMS7276', 'SAE', 'sold']);
  assert.equal(one('AMS 5643N').id, 'AMS5643');
  assert.equal(one('AMS 5643N').revision, 'N');
  const j = one('SAE J429');
  assert.deepEqual([j.id, j.access, j.publisher], ['SAE J429', 'sold', 'SAE']);
});

test('DoD-adopted industry documents: ASSIST lists the adoption notice, publisher sells the text', () => {
  const r = one('SAE-AMS-P-83461');
  assert.deepEqual([r.id, r.access, r.publisher, r.family], ['SAE-AMS-P-83461', 'adopted', 'SAE', 'ADOPTED']);
  assert.equal(one('AMS-QQ-A-250/4').access, 'adopted');
  assert.equal(one('SAE-AS22759/11').access, 'adopted');
  assert.equal(one('SAE-AS22759/11').id, 'SAE-AS22759/11');
});

test('ASTM, ASME and ISO are sold by their publishers', () => {
  const a = one('ASTM B209-10');
  assert.deepEqual([a.id, a.revision, a.publisher, a.access], ['ASTM B209', '10', 'ASTM', 'sold']);
  assert.equal(one('ASTM-F593').id, 'ASTM F593');
  assert.equal(one('ASTM A582M').id, 'ASTM A582M');
  const s = one('ANSI/ASME B18.2.1');
  assert.deepEqual([s.id, s.publisher], ['ASME B18.2.1', 'ASME']);
  assert.equal(one('ANSI B18.3').id, 'ASME B18.3');
  const i = one('ISO 4762');
  assert.deepEqual([i.id, i.publisher, i.access], ['ISO 4762', 'ISO', 'sold']);
  assert.equal(one('ISO 898-1').id, 'ISO 898-1');
});

test('several documents in one reply, in order, de-duplicated', () => {
  assert.deepEqual(ids('MIL-S-25043 OR ASTM B209-10; MIL-S-25043 AGAIN'), ['MIL-S-25043', 'ASTM B209']);
});

test('dash look-alikes and lower case are normalised', () => {
  assert.equal(one('mil–dtl–25988').id, 'MIL-DTL-25988');
  assert.equal(one('ms35338‑44').id, 'MS35338');
});

test('no false positives inside words or longer codes', () => {
  assert.deepEqual(ids('HAMS7276 PRAMS5643 BMS35338'), []);
  // A CAGE prefix before a hyphen is allowed (FLIS writes 81349-MIL-...), so this is the one place a hyphen may precede.
  assert.deepEqual(ids('12345-AS568'), ['AS568']);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('INCHES NOMINAL 0.7500'), []);
});

test('truncated FLIS document fields are repaired only with their kind label', () => {
  assert.deepEqual(ids('FED SPEC SINGLE MATERIAL RESPONSE QQ-A-250 TO 1, 0 OVERALL MIL SPEC SINGLE MATERIAL RESPONSE -IL-S-25043'), ['QQ-A-250', 'MIL-S-25043']);
  const refs = extractStandardRefs('OVERALL MIL SPEC SINGLE MATERIAL RESPONSE -IL-S-25043');
  assert.deepEqual(refs.map((r) => [r.id, r.inferred]), [['MIL-S-25043', true]]);
  const a = extractStandardRefs('ASSN STD SINGLE MATERIAL RESPONSE AST- B209-10, 1100 H-14');
  assert.deepEqual(a.map((r) => [r.id, r.inferred]), [['ASTM B209', true]]);
  // Without the kind label nothing is guessed.
  assert.deepEqual(ids('SOMETHING -IL-S-25043'), []);
  assert.deepEqual(ids('SOMETHING AST- B209-10'), []);
});

test('part numbers under the standards CAGEs are the standard itself', () => {
  const ms = standardFromPartNumber('MS35338-44', '96906')!;
  assert.deepEqual([ms.ref.id, ms.ref.suffix, ms.govCage], ['MS35338', '44', true]);
  const an = standardFromPartNumber('AN960-10', '88044')!;
  assert.deepEqual([an.ref.id, an.ref.suffix, an.govCage], ['AN960', '10', true]);
  const nas = standardFromPartNumber('NAS1352-4-6', '80205')!;
  assert.deepEqual([nas.ref.id, nas.ref.access, nas.govCage], ['NAS1352', 'sold', true]);
  const mil = standardFromPartNumber('MIL-DTL-25988', '81349')!;
  assert.deepEqual([mil.ref.id, mil.govCage], ['MIL-DTL-25988', true]);
  const fed = standardFromPartNumber('FF-W-84', '81348')!;
  assert.deepEqual([fed.ref.id, fed.ref.family], ['FF-W-84', 'FED']);
});

test('catalog M numbers under CAGE 81349 are specification sheets with a searchable partial id', () => {
  const m = standardFromPartNumber('M23053/5-101', '81349')!;
  assert.deepEqual([m.ref.id, m.ref.family, m.ref.suffix, m.ref.searchTerm], ['M23053/5', 'M-SHEET', '101', '23053/5']);
  assert.equal(standardFromPartNumber('M23053/5-101', '12345'), null);
});

test('a manufacturer CAGE with a standard number still yields the document but not govCage', () => {
  const r = standardFromPartNumber('MS35338-44', '12345')!;
  assert.deepEqual([r.ref.id, r.govCage], ['MS35338', false]);
});

test('part numbers that only contain a standard number are not the standard', () => {
  assert.equal(standardFromPartNumber('MS35338-44 BOLT KIT', '96906'), null);
  assert.equal(standardFromPartNumber('KIT-MS35338-44', '96906'), null);
  assert.equal(standardFromPartNumber('BL-2900-56', '12345'), null);
  assert.equal(standardFromPartNumber('', '96906'), null);
});

test('inferred undashed MS part number keeps its suffix', () => {
  const r = standardFromPartNumber('MS35338144', '96906')!;
  assert.deepEqual([r.ref.id, r.ref.suffix, r.ref.inferred], ['MS35338', '144', true]);
});

test('ASSIST link only for government and adopted documents', () => {
  assert.equal(assistUrl(one('MS35338-44')), ASSIST_QUICK_SEARCH_URL);
  assert.equal(assistUrl(one('SAE-AMS-P-83461')), ASSIST_QUICK_SEARCH_URL);
  assert.equal(assistUrl(one('AMS7276')), null);
  assert.equal(assistUrl(one('NAS1352-4-6')), null);
  assert.equal(assistUrl(one('ASTM A276')), null);
  assert.equal(ASSIST_QUICK_SEARCH_URL, 'https://quicksearch.dla.mil/');
});

test('action labels and availability text', () => {
  assert.equal(standardActionLabel(one('MIL-DTL-25988')), 'Open in ASSIST');
  assert.equal(standardActionLabel(one('SAE-AMS-P-83461')), 'Open adoption notice in ASSIST');
  assert.equal(standardActionLabel(one('AMS7276')), 'Sold by SAE');
  assert.equal(standardActionLabel(one('NAS1352')), 'Sold by AIA');
  assert.equal(standardActionLabel(one('ASTM B209')), 'Sold by ASTM');
  assert.match(standardAvailability(one('AMS7276')), /bought from SAE International; we do not link a copy/);
  assert.match(standardAvailability(one('SAE-AMS-P-83461')), /adoption notice/);
  for (const t of ['MS35338-44', 'AMS7276', 'SAE-AMS-P-83461', 'NAS1352']) {
    assert.doesNotMatch(standardAvailability(one(t)), /[—–]/);
  }
});

test('dash sentence only for sheet families with a known suffix', () => {
  const ms = one('MS35338-44');
  assert.equal(
    suffixSentence(ms, ms as never),
    'This part number is dash number 44 of MS35338. The table on that sheet gives the dimensions for dash number 44.'
  );
  const an = one('AN960C10');
  assert.match(suffixSentence(an, an as never)!, /ends in C10, a variant code on AN960/);
  const mil = one('MIL-DTL-83513/01');
  assert.equal(suffixSentence(mil, { suffix: '5', suffixStyle: 'dash' }), null);
  assert.equal(suffixSentence(ms, { suffix: null, suffixStyle: null }), null);
});

test('collectStandardDocs merges part numbers and characteristics, de-duplicates, orders part-number sheets first', () => {
  const docs = collectStandardDocs({
    characteristics: [
      { requirement: 'SPECIFICATION/STANDARD DATA', reply: '81349-MIL-DTL-25988 CLASS 1' },
      { requirement: 'MATERIAL', reply: 'ASTM B209-10' },
      { requirement: 'LENGTH', reply: 'INCHES NOMINAL 0.7500' },
      { requirement: 'END ITEM', reply: 'MS35338' },
      { requirement: 'X', reply: null },
    ],
    partNumbers: [
      { partNumber: 'MS35338-44', cage: '96906' },
      { partNumber: 'MS35338-45', cage: '96906' },
      { partNumber: 'BL-2900-56', cage: '12345' },
    ],
  });
  assert.deepEqual(docs.map((d) => d.id), ['MS35338', 'MIL-DTL-25988', 'ASTM B209']);
  assert.deepEqual(docs[0].sources, ['part_number', 'characteristic']);
  assert.deepEqual(docs[0].partNumbers.map((p) => [p.partNumber, p.suffix, p.govCage]), [['MS35338-44', '44', true], ['MS35338-45', '45', true]]);
  assert.deepEqual(docs[1].partNumbers, []);
});

test('collectStandardDocs: no documents for a plain commercial part', () => {
  assert.deepEqual(collectStandardDocs({ characteristics: [{ reply: 'COPPER ALLOY' }], partNumbers: [{ partNumber: 'BL-2900-56', cage: '53711' }] }), []);
});

test('collectStandardDocs caps the list at eight', () => {
  const characteristics = Array.from({ length: 12 }, (_, i) => ({ reply: `MIL-DTL-${10000 + i}` }));
  assert.equal(collectStandardDocs({ characteristics, partNumbers: [] }).length, 8);
});
