import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amcGloss, amscGloss, competitionOf, competitionSentence } from './shared.ts';

test('AMC decides competition; AMSC G only when there is no usable AMC (PGI 217.7506)', () => {
  assert.equal(competitionOf('1', 'G'), 'open');
  assert.equal(competitionOf('2', 'Z'), 'open');
  assert.equal(competitionOf('3', 'C'), 'restricted');
  assert.equal(competitionOf('4', 'Z'), 'restricted');
  assert.equal(competitionOf('5', 'P'), 'restricted');
  assert.equal(competitionOf(null, 'G'), 'open');
  assert.equal(competitionOf('0', 'G'), 'open');
  // Z is a commercial or off-the-shelf item; on its own it says nothing about competition.
  assert.equal(competitionOf(null, 'Z'), 'unknown');
  assert.equal(competitionOf('0', 'O'), 'unknown');
  assert.equal(competitionOf(null, null), 'unknown');
});

test('sentences state the code on record and nothing more', () => {
  assert.match(competitionSentence('1', 'G'), /suitable for competitive acquisition \(AMC 1\)/);
  assert.match(competitionSentence('3', 'C'), /directly from the actual manufacturer \(AMC 3\)/);
  assert.match(competitionSentence('5', null), /sole-source contractor that is not the actual manufacturer/);
  assert.match(competitionSentence(null, null), /No acquisition method code is on record/);
  assert.match(competitionSentence('0', 'Z'), /do not say whether/);
});

test('glosses come from the one table', () => {
  assert.equal(amscGloss('Z'), 'AMSC Z: a commercial, nondevelopmental or off-the-shelf item.');
  assert.equal(amcGloss('2'), 'AMC 2: suitable for competitive acquisition, first time.');
  assert.equal(amscGloss('E'), 'AMSC E');
  assert.equal(amscGloss(null), null);
});
