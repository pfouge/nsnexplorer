import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessedSentence, citationBase, longDate, longDateOf } from './cite.ts';

test('longDate formats ISO dates without a timezone shift', () => {
  assert.equal(longDate('2026-10-04'), 'October 4, 2026');
  assert.equal(longDate('2026-01-31T23:59:59.000Z'), 'January 31, 2026');
  assert.equal(longDate('2026-12-09'), 'December 9, 2026');
  assert.equal(longDate('nope'), '');
  assert.equal(longDate('2026-13-01'), '');
});

test('citation follows the one-line format', () => {
  assert.equal(
    citationBase('Fasteners FSC 5305', 'https://nsnexplorer.com/fsc/5305/', '2026-10-04'),
    'NSN Explorer. "Fasteners FSC 5305." nsnexplorer.com, https://nsnexplorer.com/fsc/5305/. Data as of October 4, 2026.'
  );
});

test('a title that already ends in punctuation is not given a second period', () => {
  assert.match(citationBase('Why is an agency missing?', 'https://nsnexplorer.com/x/', '2026-10-04'), /^NSN Explorer\. "Why is an agency missing\?" nsnexplorer\.com/);
});

test('accessed sentence uses the viewer clock', () => {
  assert.equal(accessedSentence(new Date(2026, 9, 10, 23, 30)), ' Accessed October 10, 2026.');
  assert.equal(longDateOf(new Date(2026, 0, 1)), 'January 1, 2026');
});
