import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvObjects, findColumn } from '../csv.mjs';

test('parseCsv: simple comma-delimited rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('parseCsv: quoted field with embedded comma', () => {
  const rows = parseCsv('NIIN,ITEM_NAME\n002915924,"O-RING, STATIC"\n');
  assert.deepEqual(rows, [
    ['NIIN', 'ITEM_NAME'],
    ['002915924', 'O-RING, STATIC'],
  ]);
});

test('parseCsv: doubled-quote escaping inside quoted field', () => {
  const rows = parseCsv('NAME\n"Say ""hello"""\n');
  assert.deepEqual(rows, [['NAME'], ['Say "hello"']]);
});

test('parseCsv: embedded newline inside quoted field', () => {
  const rows = parseCsv('A,B\n"line1\nline2",2\n');
  assert.deepEqual(rows, [
    ['A', 'B'],
    ['line1\nline2', '2'],
  ]);
});

test('parseCsv: CRLF line endings', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parseCsv: no trailing newline still yields last row', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('parseCsvObjects: builds header-keyed objects', () => {
  const { headers, rows } = parseCsvObjects('NIIN,ITEM_NAME\n002915924,O-RING\n012345678,GASKET\n');
  assert.deepEqual(headers, ['NIIN', 'ITEM_NAME']);
  assert.deepEqual(rows, [
    { NIIN: '002915924', ITEM_NAME: 'O-RING' },
    { NIIN: '012345678', ITEM_NAME: 'GASKET' },
  ]);
});

test('findColumn: case-insensitive match against first candidate', () => {
  const col = findColumn(['Niin', 'Item_Name'], ['NIIN']);
  assert.equal(col, 'Niin');
});

test('findColumn: falls through candidate list in order', () => {
  const col = findColumn(['ITEM_NAME_1'], ['ITEM_NAME', 'ITEM_NAME_1']);
  assert.equal(col, 'ITEM_NAME_1');
});

test('findColumn: returns null when not required and nothing matches', () => {
  assert.equal(findColumn(['FOO'], ['NIIN']), null);
});

test('findColumn: throws with a clear message listing found headers when required', () => {
  assert.throws(
    () => findColumn(['FOO', 'BAR'], ['NIIN'], { required: true }),
    /NIIN.*FOO, BAR/s
  );
});
