import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DESCRIPTION, article, fitDescription, fscDescription, fscTitle, groupDescription, groupIntro, groupTitle, lowerName, monthYear, niinDashed, nomen, nsnDescription,
  nsnFacet, nsnSummary, nsnTitle, openDescription, openTitle, type NsnCopyInput,
} from './seo-copy.ts';

test('nomen: comma spacing and Title Case', () => {
  assert.equal(nomen('CLIP,RETAINING'), 'Clip, Retaining');
  assert.equal(nomen('O-RING'), 'O-Ring');
  assert.equal(nomen('SCREW,CAP,HEXAGON HEAD'), 'Screw, Cap, Hexagon Head');
  assert.equal(nomen('NUT,SELF-LOCKING,EX'), 'Nut, Self-Locking, Ex');
});

test('nomen: tokens with digits and short all-consonant tokens stay upper-case', () => {
  assert.equal(nomen('BOLT,10-32UNF,SS'), 'Bolt, 10-32UNF, SS');
  assert.equal(nomen('HOSE ASSEMBLY,PVC,RH'), 'Hose Assembly, PVC, RH');
  assert.equal(nomen('BRACKET,ANGLE 1/2 IN'), 'Bracket, Angle 1/2 In');
  assert.equal(nomen("WOMEN'S SOCK"), "Women's Sock");
  assert.equal(nomen('  washer ,  flat '), 'Washer, Flat');
});

test('nomen: missing names', () => {
  assert.equal(nomen(null), 'Unnamed Item');
  assert.equal(nomen(undefined), 'Unnamed Item');
  assert.equal(nomen('   '), 'Unnamed Item');
});

test('fitDescription drops trailing clauses until it fits, never mid-clause', () => {
  const a = 'A'.repeat(100) + '.';
  const b = ' ' + 'B'.repeat(40) + '.';
  const c = ' ' + 'C'.repeat(30) + '.';
  assert.equal(fitDescription([a, b, c]), a + b);
  assert.equal(fitDescription([a, b]), a + b);
  assert.equal(fitDescription([a, c, b]), a + c);
});

test('fitDescription 160-character boundary', () => {
  const head = 'x'.repeat(100);
  const exactly = ' ' + 'y'.repeat(59); // 160 total
  const one_over = ' ' + 'y'.repeat(60); // 161 total
  assert.equal(fitDescription([head, exactly]).length, 160);
  assert.equal(fitDescription([head, one_over]), head);
  assert.equal(fitDescription([head, one_over], { max: 161 }).length, 161);
});

test('fitDescription counts the prefix and falls back to shorter first clauses', () => {
  const out = fitDescription([['L'.repeat(150) + '.', 'short.'], ' tail.'], { prefix: 'Page 2 of 9. ' });
  assert.equal(out, 'Page 2 of 9. short. tail.');
  assert.ok(out.length <= MAX_DESCRIPTION);
  const prefixed = fitDescription(['p'.repeat(140), ' ' + 'q'.repeat(10)], { prefix: 'Page 2 of 3. ' });
  assert.equal(prefixed, 'Page 2 of 3. ' + 'p'.repeat(140));
});

test('fitDescription last resort trims at a word boundary', () => {
  const out = fitDescription([('word '.repeat(60)).trim()]);
  assert.ok(out.length <= MAX_DESCRIPTION && out.endsWith('…'));
});

test('class title and description: named, with and without open solicitations', () => {
  const c = { code: '5340', name: 'Hardware, Commercial', nsnCount: 3705, openCount: 12 };
  assert.equal(fscTitle(c), 'FSC 5340 Hardware, Commercial: 3,705 NSNs, Prices & Open RFQs');
  assert.equal(fscTitle({ ...c, openCount: 0 }), 'FSC 5340 Hardware, Commercial: 3,705 NSNs, Specs & Award Prices');
  assert.equal(fscDescription(c), 'Browse 3,705 NSNs in FSC 5340 Hardware, Commercial: specs, part numbers and award prices. 12 open solicitations. Free, linked to government source records.');
  assert.equal(fscDescription({ ...c, openCount: 0 }), 'Browse 3,705 NSNs in FSC 5340 Hardware, Commercial: specs, part numbers and award prices. Free, linked to government source records.');
});

test('class copy: singular forms and unlisted classes', () => {
  const one = { code: '4820', name: 'Valves, Nonpowered', nsnCount: 1, openCount: 1 };
  assert.equal(fscTitle(one), 'FSC 4820 Valves, Nonpowered: 1 NSN, Prices & Open RFQs');
  assert.match(fscDescription(one), /^Browse 1 NSN in FSC 4820 .* 1 open solicitation\. Free/);
  const unlisted = { code: '1046', name: null, nsnCount: 20, openCount: 0 };
  assert.equal(fscTitle(unlisted), 'FSC 1046 (Unlisted Supply Class): 20 NSNs');
  assert.equal(fscDescription(unlisted), '20 NSNs in FSC 1046, a supply class the federal handbook does not list. Specs, part numbers and award records, linked to government sources.');
});

test('class description stays <= 160 with a very long class name and with a page prefix', () => {
  const long = { code: '1234', name: 'Fire Fighting, Rescue, and Safety Equipment; and Environmental Protection Equipment and Materials', nsnCount: 12345, openCount: 7 };
  for (const prefix of ['', 'Page 12 of 40. ']) {
    const d = fscDescription(long, prefix);
    assert.ok(d.length <= 160, `${d.length}: ${d}`);
    assert.ok(d.startsWith(prefix));
  }
});

test('open title and description', () => {
  const o = { code: '5340', name: 'Hardware, Commercial', openCount: 42, nsnCount: 30 };
  assert.equal(openTitle(o), 'FSC 5340 Open Solicitations: 42 RFQs for Hardware, Commercial');
  assert.equal(openTitle({ ...o, openCount: 1 }), 'FSC 5340 Open Solicitations: 1 RFQ for Hardware, Commercial');
  assert.equal(openTitle({ ...o, openCount: 0 }), 'FSC 5340 Solicitations for Hardware, Commercial: None Open Now');
  assert.equal(openDescription(o), '42 open DLA solicitations for FSC 5340 Hardware, Commercial across 30 NSNs, with quantities and closing dates. Linked to the official RFQ. Updated daily.');
  assert.match(openDescription({ ...o, openCount: 1, nsnCount: 1 }), /^1 open DLA solicitation for FSC 5340 .* across 1 NSN, /);
  assert.ok(openDescription({ ...o, name: 'X'.repeat(120) }).length <= 160);
});

test('group title, description and intro', () => {
  const g = { fsg: '53', name: 'Hardware and Abrasives', classCount: 12, nsnCount: 9876 };
  assert.equal(groupTitle(g), 'FSG 53 Hardware and Abrasives: 12 Supply Classes, 9,876 NSNs');
  assert.equal(groupTitle({ ...g, classCount: 1, nsnCount: 1 }), 'FSG 53 Hardware and Abrasives: 1 Supply Class, 1 NSN');
  assert.equal(groupDescription(g), 'Federal Supply Group 53, Hardware and Abrasives: 12 supply classes and 9,876 NSNs with specs, part numbers, award prices and open solicitations.');
  const longName = { fsg: '70', name: 'Information Technology Equipment (Including Firmware), Software, Supplies and Support Equipment', classCount: 12, nsnCount: 9876 };
  assert.ok(groupDescription(longName).length <= 160);
  const intro = groupIntro({ ...g, topClasses: [{ label: 'Hardware, Commercial', nsnCount: 1300 }, { label: 'O-Ring', nsnCount: 500 }, { label: 'Nuts', nsnCount: 40 }, { label: 'Pins', nsnCount: 3 }], openCount: 5 });
  assert.equal(intro, 'Federal Supply Group 53 covers hardware and abrasives. NSN Explorer tracks 9,876 stock numbers across 12 supply classes in this group. The largest are Hardware, Commercial (1,300), O-Ring (500) and Nuts (40). 5 solicitations are open in this group today.');
  assert.ok(!/open in this group/.test(groupIntro({ ...g, topClasses: [], openCount: 0 })));
  assert.match(groupIntro({ ...g, topClasses: [{ label: 'X', nsnCount: 2 }], openCount: 1 }), /1 solicitation is open/);
});

test('lowerName keeps acronyms, article picks a/an, month formatting, niin', () => {
  assert.equal(lowerName('Information Technology Equipment (Including Firmware), Software'), 'information technology equipment (including firmware), software');
  assert.equal(lowerName('IT Equipment and Parts'), 'IT equipment and parts');
  assert.equal(article('o-ring'), 'an');
  assert.equal(article('clip, retaining'), 'a');
  assert.equal(monthYear('2026-03-14'), 'Mar 2026');
  assert.equal(monthYear(null), null);
  assert.equal(niinDashed('5340000000001'), '00-000-0001');
});

const base: NsnCopyInput = {
  dashed: '5340-00-123-4567', itemName: 'CLIP,RETAINING', fscCode: '5340', fscName: 'Hardware, Commercial',
  pricePoints: 3, openSolicitations: 0, hasCharacteristics: true, partNumbers: 4, suppliers: 2, lastPurchased: '2026-03-14',
};

test('NSN title facets in priority order', () => {
  assert.equal(nsnTitle(base), 'NSN 5340-00-123-4567 Clip, Retaining: Price History & Specs');
  assert.equal(nsnFacet({ ...base, pricePoints: 0, openSolicitations: 2 }), 'Open RFQ & Specs');
  assert.equal(nsnFacet({ ...base, pricePoints: 0 }), 'Specs & Part Numbers');
  assert.equal(nsnFacet({ ...base, pricePoints: 0, hasCharacteristics: false, partNumbers: 1 }), 'Specs & Part Numbers');
  assert.equal(nsnFacet({ ...base, pricePoints: 0, hasCharacteristics: false, partNumbers: 0 }), 'Item Details');
  assert.equal(nsnTitle({ ...base, itemName: null, pricePoints: 0, hasCharacteristics: false, partNumbers: 0 }), 'NSN 5340-00-123-4567 Unnamed Item: Item Details');
});

test('NSN description clauses', () => {
  assert.equal(nsnDescription(base), 'NSN 5340-00-123-4567 (Clip, Retaining) in FSC 5340 Hardware, Commercial. 4 part numbers from 2 suppliers. Last award Mar 2026. Free, linked to source records.');
  assert.equal(nsnDescription({ ...base, openSolicitations: 3 }), 'NSN 5340-00-123-4567 (Clip, Retaining) in FSC 5340 Hardware, Commercial. 4 part numbers from 2 suppliers. 3 open solicitations. Free, linked to source records.');
  assert.equal(nsnDescription({ ...base, partNumbers: 1, suppliers: 1, lastPurchased: null, pricePoints: 0 }), 'NSN 5340-00-123-4567 (Clip, Retaining) in FSC 5340 Hardware, Commercial. 1 part number from 1 supplier. Free, linked to source records.');
  assert.equal(nsnDescription({ ...base, partNumbers: 0, suppliers: 0, lastPurchased: null }), 'NSN 5340-00-123-4567 (Clip, Retaining) in FSC 5340 Hardware, Commercial. Free, linked to source records.');
  assert.equal(nsnDescription({ ...base, fscName: null }), 'NSN 5340-00-123-4567 (Clip, Retaining) in FSC 5340 (unlisted supply class). 4 part numbers from 2 suppliers. Last award Mar 2026.'); // the 4th clause would pass 160 and is dropped whole
  const long = nsnDescription({ ...base, itemName: 'X'.repeat(70), fscName: 'Y'.repeat(60), openSolicitations: 12 });
  assert.ok(long.length <= 160, long);
});

test('NSN summary paragraph', () => {
  const s = nsnSummary({ ...base, nsn13: '5340001234567' });
  assert.equal(s, 'NSN 5340-00-123-4567 (also written 5340001234567; NIIN 00-123-4567) is a clip, retaining in Federal Supply Class 5340, Hardware, Commercial. 4 manufacturer part numbers from 2 suppliers are on record. It was last purchased in Mar 2026.');
  assert.match(nsnSummary({ ...base, nsn13: '5340001234567', openSolicitations: 2 }), /The government has 2 open solicitations for it\.$/);
  const bare = nsnSummary({ ...base, nsn13: '5340001234567', itemName: null, partNumbers: 0, suppliers: 0, lastPurchased: null });
  assert.equal(bare, 'NSN 5340-00-123-4567 (also written 5340001234567; NIIN 00-123-4567) is an unnamed item in Federal Supply Class 5340, Hardware, Commercial. No purchases are on record yet.');
  assert.match(nsnSummary({ ...base, nsn13: '5340001234567', partNumbers: 1, suppliers: 1 }), /1 manufacturer part number from 1 supplier is on record\./);
});
