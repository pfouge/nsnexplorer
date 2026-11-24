import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparkPath } from './spark.ts';

test('sparkPath needs two points', () => {
  assert.equal(sparkPath([]), null);
  assert.equal(sparkPath([3]), null);
});
test('sparkPath spans the box and ends on the last value', () => {
  const s = sparkPath([1, 3, 2])!;
  assert.match(s.d, /^M2\.0 22\.0L48\.0 2\.0L94\.0 12\.0$/);
  assert.equal(s.x, 94);
  assert.equal(s.y, 12);
});
test('flat series draws a centred line', () => {
  assert.match(sparkPath([5, 5])!.d, /M2\.0 12\.0L94\.0 12\.0/);
});
