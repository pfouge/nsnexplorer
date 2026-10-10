import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SUPPLIER_DESCRIPTION,
  MAX_TITLE,
  countdownBadge,
  daysUntilClose,
  statusBadge,
  escapeLike,
  isSolNumber,
  parseCageParam,
  parseSupplierQuery,
  schemaText,
  solicitationPath,
  supplierDescription,
  supplierLede,
  supplierPath,
  supplierPlace,
  supplierTitle,
  trimName,
} from './entity.ts';

const base = { cage: '1ABC2', name: 'ACME FASTENERS INC', awards: 14, classes: 3, latest: '2026-04-09' };

test('parseCageParam: canonical, lower-case redirect, invalid', () => {
  assert.deepEqual(parseCageParam('1ABC2'), { kind: 'ok', cage: '1ABC2' });
  assert.deepEqual(parseCageParam('1abc2'), { kind: 'redirect', cage: '1ABC2' });
  assert.deepEqual(parseCageParam('1aBc2'), { kind: 'redirect', cage: '1ABC2' });
  for (const bad of ['', '1ABC', '1ABC23', '1AB-2', '1AB C', '1ÀBC2', '../etc']) {
    assert.deepEqual(parseCageParam(bad), { kind: 'invalid' }, bad);
  }
});

test('isSolNumber: letters, digits and dashes only', () => {
  assert.equal(isSolNumber('SPE7M3-26-Q-0421'), true);
  assert.equal(isSolNumber('W911NF26R0001'), true);
  for (const bad of ['', 'a b', 'a/b', 'a_b', 'a.b', '../x', 'a%20b', null, undefined, 'x'.repeat(81)]) {
    assert.equal(isSolNumber(bad as string), false, String(bad));
  }
});

test('solicitationPath / supplierPath return null for unusable values', () => {
  assert.equal(solicitationPath('SPE7M3-26-Q-0421'), '/solicitation/SPE7M3-26-Q-0421/');
  assert.equal(solicitationPath('a b'), null);
  assert.equal(solicitationPath(null), null);
  assert.equal(supplierPath('1ABC2'), '/supplier/1ABC2/');
  assert.equal(supplierPath('1abc2'), null);
  assert.equal(supplierPath(null), null);
});

test('trimName keeps short names and cuts long ones at a word with an ellipsis', () => {
  assert.equal(trimName('ACME  FASTENERS INC', 40), 'ACME FASTENERS INC');
  const t = trimName('NORTHROP GRUMMAN SYSTEMS CORPORATION', 22);
  assert.ok(t.length <= 22, t);
  assert.ok(t.endsWith('…'));
  assert.equal(t, 'NORTHROP GRUMMAN…');
  assert.ok(trimName('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJ', 10).length <= 10);
});

test('supplierTitle stays within 60 characters before the site suffix', () => {
  assert.equal(supplierTitle('ACME FASTENERS INC', '1ABC2'), 'ACME FASTENERS INC (CAGE 1ABC2): Government Parts Awards');
  for (const name of ['A', 'ACME FASTENERS INC', 'NORTHROP GRUMMAN SYSTEMS CORPORATION', 'X'.repeat(120), 'LOCKHEED MARTIN ROTARY AND MISSION SYSTEMS']) {
    const t = supplierTitle(name, '1ABC2');
    assert.ok(t.length <= MAX_TITLE, `${t.length} ${t}`);
    assert.ok(t.endsWith(' (CAGE 1ABC2): Government Parts Awards'));
  }
  assert.equal(supplierTitle(null, '1ABC2'), 'CAGE 1ABC2: Government Parts Awards');
  assert.equal(supplierTitle('   ', '1ABC2'), 'CAGE 1ABC2: Government Parts Awards');
});

test('supplierLede states counts and the latest month', () => {
  assert.equal(
    supplierLede(base),
    'ACME FASTENERS INC (CAGE 1ABC2) appears as the awardee on 14 indexed government parts awards across 3 federal supply classes, most recently in Apr 2026.'
  );
  assert.equal(
    supplierLede({ ...base, name: null, awards: 1, classes: 1, latest: null }),
    'CAGE 1ABC2 appears as the awardee on 1 indexed government parts award across 1 federal supply class.'
  );
  assert.equal(supplierLede({ ...base, awards: 1200 }).includes('1,200 indexed'), true);
});

test('supplierDescription is at most 155 characters and keeps the facts', () => {
  const d = supplierDescription(base);
  assert.ok(d.length <= MAX_SUPPLIER_DESCRIPTION, d);
  assert.ok(d.startsWith('ACME FASTENERS INC (CAGE 1ABC2) appears as the awardee on 14 indexed'));
  const long = supplierDescription({ ...base, name: 'LOCKHEED MARTIN ROTARY AND MISSION SYSTEMS INCORPORATED OF AMERICA', awards: 12345 });
  assert.ok(long.length <= MAX_SUPPLIER_DESCRIPTION, `${long.length} ${long}`);
  assert.ok(long.includes('CAGE 1ABC2'));
  assert.ok(long.includes('12,345'));
});

test('supplierPlace shows city and state only', () => {
  assert.equal(supplierPlace('Dayton', 'OH'), 'Dayton, OH');
  assert.equal(supplierPlace('Dayton', null), 'Dayton');
  assert.equal(supplierPlace(null, 'OH'), 'OH');
  assert.equal(supplierPlace('', ' '), null);
});

test('schemaText drops angle brackets', () => {
  assert.equal(schemaText('A</script><b>'), 'A/scriptb');
});

test('parseSupplierQuery: length rule, CAGE rule, name rule', () => {
  assert.deepEqual(parseSupplierQuery('ab'), { kind: 'none' });
  assert.deepEqual(parseSupplierQuery('  a '), { kind: 'none' });
  assert.deepEqual(parseSupplierQuery('1A001'), { kind: 'cage', cage: '1A001', nameFallback: null });
  assert.deepEqual(parseSupplierQuery('ACMEF'), { kind: 'cage', cage: 'ACMEF', nameFallback: '%ACMEF%' });
  assert.deepEqual(parseSupplierQuery('acme'), { kind: 'name', pattern: '%acme%' });
  assert.deepEqual(parseSupplierQuery('1a001'), { kind: 'name', pattern: '%1a001%' });
  assert.deepEqual(parseSupplierQuery('50%_off'), { kind: 'name', pattern: '%50\\%\\_off%' });
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
});

test('daysUntilClose / countdownBadge compute from the request date', () => {
  const today = new Date('2026-10-10T15:30:00Z');
  assert.equal(daysUntilClose('2026-10-10', today), 0);
  assert.equal(daysUntilClose('2026-10-11', today), 1);
  assert.equal(daysUntilClose('2026-10-24', today), 14);
  assert.equal(daysUntilClose(null, today), null);
  assert.deepEqual(countdownBadge(null), { text: 'Close date unknown', cls: '' });
  assert.deepEqual(countdownBadge(0), { text: 'Closes today', cls: 'amber' });
  assert.deepEqual(countdownBadge(1), { text: 'Closes in 1 day', cls: 'amber' });
  assert.deepEqual(countdownBadge(2), { text: 'Closes in 2 days', cls: 'amber' });
  assert.deepEqual(countdownBadge(14), { text: 'Closes in 14 days', cls: 'green' });
});

test('statusBadge', () => {
  assert.deepEqual(statusBadge('open'), { text: 'Open', cls: 'green' });
  assert.deepEqual(statusBadge('awarded'), { text: 'Awarded', cls: '' });
});
