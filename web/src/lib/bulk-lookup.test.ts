import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, parseBulkInput, toCsv } from './bulk-lookup.ts';

const A = '5340013967260';
const B = '5340002303256';

test('every separator splits tokens', () => {
  for (const sep of ['\n', '\r\n', ',', ';', '\t', '  ', '   ', ' , ', ',\n']) {
    assert.deepEqual(parseBulkInput(`${A}${sep}${B}`).nsns, [A, B], JSON.stringify(sep));
  }
});

test('dashes and single spaces stay inside one NSN', () => {
  const r = parseBulkInput('5340-01-396-7260\n5340 00 230 3256\n5340013967261');
  assert.deepEqual(r.nsns, [A, B, '5340013967261']);
  assert.deepEqual(r.rejected, []);
});

test('NIINs: nine digits with or without hyphens', () => {
  const r = parseBulkInput('01-396-7260, 013967260 ,002303256');
  assert.deepEqual(r.niins, ['013967260', '002303256']);
  assert.deepEqual(r.nsns, []);
});

test('dedupes in input order, across formats', () => {
  const r = parseBulkInput(`${B}\n${A}\n5340-01-396-7260\n${B}`);
  assert.deepEqual(r.nsns, [B, A]);
});

test('rejects tokens that are neither, ignores empties and a header', () => {
  const r = parseBulkInput('NSN\n\n5340-01-39\nabc\n12345678901234\n' + A + '\nabc\n,,;');
  assert.deepEqual(r.nsns, [A]);
  assert.deepEqual(r.rejected, ['5340-01-39', 'abc', '12345678901234']);
  assert.equal(parseBulkInput('nsn\n' + A).rejected.length, 0);
  assert.equal(parseBulkInput('NSN, ' + A).nsns.length, 1);
});

test('empty and whitespace-only input', () => {
  assert.deepEqual(parseBulkInput(''), { nsns: [], niins: [], rejected: [], truncated: false });
  assert.deepEqual(parseBulkInput(' \n\t '), { nsns: [], niins: [], rejected: [], truncated: false });
});

test('cap counts NSNs and NIINs together and flags truncation', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `53400139672${60 + i}`);
  const r = parseBulkInput([...ids, '013967260'].join('\n'), 5);
  assert.equal(r.nsns.length, 5);
  assert.equal(r.niins.length, 0);
  assert.equal(r.truncated, true);
  const exact = parseBulkInput(ids.slice(0, 5).join('\n'), 5);
  assert.equal(exact.truncated, false);
  // duplicates past the cap are not "extra"
  assert.equal(parseBulkInput([...ids.slice(0, 5), ids[0]].join('\n'), 5).truncated, false);
  assert.equal(parseBulkInput(Array.from({ length: 501 }, (_, i) => String(5340000000000 + i)).join('\n')).truncated, true);
});

test('chunk', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 50), []);
  assert.equal(chunk(Array.from({ length: 120 }, (_, i) => i), 50).length, 3);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
});

test('toCsv quotes comma, quote and newline', () => {
  const out = toCsv([['a,b', 'say "hi"', 'x\ny', 'plain']], ['h1', 'h2', 'h3', 'h4']);
  assert.ok(out.startsWith('﻿h1,h2,h3,h4\r\n'));
  assert.ok(out.endsWith('"a,b","say ""hi""","x\ny",plain\r\n'));
});

test('toCsv guards formula injection and keeps numbers', () => {
  const out = toCsv([['=SUM(A1)', '+1', '-x', '@cmd', 'ok', -12.5, '-3.5', null]]);
  assert.ok(out.endsWith("'=SUM(A1),'+1,'-x,'@cmd,ok,-12.5,-3.5,\r\n"));
});
