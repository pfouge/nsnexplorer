import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_BOM, csvCell, toCsv } from './csv.ts';

// Minimal RFC 4180 reader, used only to prove the writer round-trips.
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(CSV_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && src[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

test('plain cells stay bare, specials are quoted with doubled quotes', () => {
  assert.equal(csvCell('abc'), 'abc');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('line1\r\nline2'), '"line1\r\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(0), '0');
});

test('formula lead-ins are neutralised, plain numbers are not', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(1)'), "'@SUM(1)");
  assert.equal(csvCell('\t=1'), "'\t=1");
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell('-12.5'), '-12.5');
  assert.equal(csvCell('-3'), '-3');
  assert.equal(csvCell(-1234.5), '-1234.5');
  assert.equal(csvCell('-'), "'-");
  assert.equal(csvCell('-1-2'), "'-1-2");
  assert.equal(csvCell('a=b'), 'a=b');
});

test('toCsv: BOM, header row, CRLF, trailing CRLF', () => {
  const out = toCsv(['a', 'b'], [[1, 'x'], [null, 'y,z']]);
  assert.equal(out, `${CSV_BOM}a,b\r\n1,x\r\n,"y,z"\r\n`);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(toCsv(['only'], []), `${CSV_BOM}only\r\n`);
});

test('toCsv round-trips awkward values through a parser', () => {
  const rows = [
    ['5330', 'Packing "and" Gasket, Seals', 12, -4.5],
    ['5340', 'Multi\r\nline', null, 0],
    ['x', 'Ünïcode – dash', 1e21, 3],
  ];
  const parsed = parseCsv(toCsv(['fsc', 'name', 'n', 'amt'], rows));
  assert.deepEqual(parsed[0], ['fsc', 'name', 'n', 'amt']);
  assert.deepEqual(parsed[1], ['5330', 'Packing "and" Gasket, Seals', '12', '-4.5']);
  assert.deepEqual(parsed[2], ['5340', 'Multi\r\nline', '', '0']);
  assert.equal(parsed[3][1], 'Ünïcode – dash');
  assert.equal(parsed.length, 4);
});

test('no parsed cell of a hostile row starts with a formula character', () => {
  const hostile = ['=1+1', '+cmd|x', '-2+3', '@A1', '"=quoted"', 'ok', '-7'];
  const parsed = parseCsv(toCsv(hostile.map((_, i) => `h${i}`), [hostile]));
  for (const cell of parsed[1]) {
    assert.ok(!/^[=+\-@]/.test(cell) || /^-\d+$/.test(cell), `unsafe cell ${cell}`);
  }
  assert.equal(parsed[1][1], "'+cmd|x");
  assert.equal(parsed[1][6], '-7');
});
