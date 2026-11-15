import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanClasses, isClassCode, parseHidden, serialiseHidden, toggleHidden, visibleCount } from './hidden-classes.ts';

test('isClassCode wants exactly four digits or capitals', () => {
  assert.equal(isClassCode('5340'), true);
  assert.equal(isClassCode('AB12'), true);
  for (const bad of ['534', '53400', '53 0', 'ab12', '', null, 5340, undefined]) assert.equal(isClassCode(bad), false);
});

test('parseHidden tolerates null, junk, wrong types and mixed arrays', () => {
  assert.deepEqual(parseHidden(null), []);
  assert.deepEqual(parseHidden(''), []);
  assert.deepEqual(parseHidden('{oops'), []);
  assert.deepEqual(parseHidden('{"a":1}'), []);
  assert.deepEqual(parseHidden('["5340", 5310, "53", null, "5340", " 5330 ", "ab12"]'), ['5330', '5340', 'AB12']);
});

test('serialise then parse round-trips and sorts', () => {
  const s = serialiseHidden(['5340', '5310', '5340']);
  assert.equal(s, '["5310","5340"]');
  assert.deepEqual(parseHidden(s), ['5310', '5340']);
});

test('toggleHidden adds, removes, ignores invalid and does not mutate', () => {
  const start = ['5340'];
  assert.deepEqual(toggleHidden(start, '5310'), ['5310', '5340']);
  assert.deepEqual(toggleHidden(start, '5340'), []);
  assert.deepEqual(toggleHidden(start, 'bad'), ['5340']);
  assert.deepEqual(start, ['5340']);
});

test('cleanClasses caps the list size', () => {
  const many = Array.from({ length: 800 }, (_, i) => String(1000 + i));
  assert.equal(cleanClasses(many).length, 500);
});

test('visibleCount drops rows in hidden classes and keeps rows with no class', () => {
  const rows = ['5340', '5310', null, '5340', '1005'];
  assert.equal(visibleCount(rows, []), 5);
  assert.equal(visibleCount(rows, ['5340']), 3);
  assert.equal(visibleCount(rows, ['5340', '1005', '0173']), 2);
  assert.equal(visibleCount(rows, ['0173']), 5);
});
