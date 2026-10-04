import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, pageCount, pageFromParam, pageItems, pageParam, pageRange, pageUrl, pagedDescriptionPrefix, pagedTitle, pagerModel, rangeLabel } from './paginate.ts';

test('page counts at the 500 boundary', () => {
  assert.equal(PAGE_SIZE, 500);
  assert.deepEqual([0, 1, 3, 500, 501, 1000, 1001, 1300].map((n) => pageCount(n)), [1, 1, 1, 1, 2, 2, 3, 3]);
});

test('urls and rest params round-trip', () => {
  assert.equal(pageUrl('/fsc/5340/', 1), '/fsc/5340/');
  assert.equal(pageUrl('/fsc/5340/', 3), '/fsc/5340/page/3/');
  assert.equal(pageParam(1), undefined);
  assert.equal(pageParam(2), 'page/2');
  assert.equal(pageFromParam('page/12'), 12);
  assert.equal(pageFromParam(undefined), 1);
});

test('slices and ranges', () => {
  const items = Array.from({ length: 1300 }, (_, i) => i);
  assert.equal(pageItems(items, 1).length, 500);
  assert.equal(pageItems(items, 3).length, 300);
  assert.deepEqual(pageItems(items, 3)[0], 1000);
  assert.deepEqual(pageRange(1300, 2), { start: 501, end: 1000 });
  assert.deepEqual(pageRange(1300, 3), { start: 1001, end: 1300 });
  assert.equal(rangeLabel(501, 1000), '501–1,000');
  assert.equal(rangeLabel(501, 501), '501');
});

test('title suffix and description prefix only on pages >= 2', () => {
  assert.equal(pagedTitle('T', 1, 3), 'T');
  assert.equal(pagedTitle('T', 2, 3), 'T (Page 2 of 3)');
  assert.equal(pagedDescriptionPrefix(1, 3), '');
  assert.equal(pagedDescriptionPrefix(3, 3), 'Page 3 of 3. ');
});

test('pager model: prev/next and numbered links only up to 10 pages', () => {
  const m = pagerModel('/open/5340/', 2, 3);
  assert.equal(m.prev, '/open/5340/');
  assert.equal(m.next, '/open/5340/page/3/');
  assert.equal(m.numbers?.length, 3);
  assert.equal(m.numbers?.filter((n) => n.current).length, 1);
  assert.equal(pagerModel('/x/', 1, 11).numbers, null);
  assert.equal(pagerModel('/x/', 1, 1).next, null);
});
