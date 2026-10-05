import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEADLINE_WINDOWS, deadlineGrid, windowIndex, wrapLabel } from './viz-services.ts';

const TODAY = '2026-10-04';
const plus = (d: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const nameOf = (l: string) => `Cat ${l}`;
const n = (category: string, d: number | null) => ({ category, closesOn: d === null ? null : plus(d) });

test('windowIndex: edges of every closing window, none, and already-past dates', () => {
  const idx = (d: number | null) => windowIndex(d === null ? null : plus(d), TODAY);
  assert.deepEqual([0, 3, 4, 7, 8, 14, 15, 30, 31, 400].map(idx), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(idx(null), -1);
  assert.equal(idx(-2), 0);
  assert.equal(DEADLINE_WINDOWS.length, 5);
});

test('deadlineGrid: counts per category and window, totals, order, shading max', () => {
  const g = deadlineGrid(
    [n('J', 1), n('J', 2), n('J', 5), n('J', 40), n('R', 10), n('R', 20), n('Y', 3), n('other', 1)],
    TODAY, nameOf
  )!;
  assert.deepEqual(g.rows.map((r) => r.letter), ['J', 'R', 'Y']);
  assert.deepEqual(g.rows[0].counts, [2, 1, 0, 0, 1]);
  assert.deepEqual(g.rows[1].counts, [0, 0, 1, 1, 0]);
  assert.equal(g.rows[0].total, 4);
  assert.equal(g.max, 2);
  assert.equal(g.total, 7, 'uncoded notices are excluded');
  assert.equal(g.columns.length, 5, 'no "No date" column when every notice has a date');
});

test('deadlineGrid: "No date" column appears only when a notice lacks a date', () => {
  const g = deadlineGrid([n('J', null), n('J', 2), n('R', null)], TODAY, nameOf)!;
  assert.equal(g.columns.length, 6);
  assert.equal(g.columns[5].label, 'No date');
  assert.deepEqual(g.rows[0].counts, [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(g.rows[1].counts, [0, 0, 0, 0, 0, 1]);
});

test('deadlineGrid: minimum two categories, ties break by letter', () => {
  assert.equal(deadlineGrid([n('J', 1), n('J', 2)], TODAY, nameOf), null);
  assert.equal(deadlineGrid([n('other', 1), n('other', 2)], TODAY, nameOf), null);
  const g = deadlineGrid([n('R', 1), n('J', 1)], TODAY, nameOf)!;
  assert.deepEqual(g.rows.map((r) => r.letter), ['J', 'R']);
});

test('deadlineGrid: more categories than rows are summed into "Other categories"', () => {
  const letters = 'ABCDEFGHJKLM'.split('');
  const notices = letters.flatMap((l, i) => Array.from({ length: 20 - i }, (_, k) => n(l, k)));
  const g = deadlineGrid(notices, TODAY, nameOf, 5)!;
  assert.equal(g.rows.length, 5);
  assert.deepEqual(g.rows.slice(0, 4).map((r) => r.letter), ['A', 'B', 'C', 'D']);
  const other = g.rows[4];
  assert.equal(other.letter, null);
  assert.equal(other.name, 'Other categories');
  assert.equal(other.categories, letters.length - 4);
  assert.equal(g.rows.reduce((s, r) => s + r.total, 0), notices.length, 'nothing lost in the roll-up');
  assert.equal(other.counts.reduce((a, b) => a + b, 0), other.total);
});

test('wrapLabel wraps on words and ellipsizes the last line', () => {
  assert.deepEqual(wrapLabel('8(a) Sole Source', 30), ['8(a) Sole Source']);
  assert.deepEqual(wrapLabel('Women-Owned Small Business Program', 20), ['Women-Owned Small', 'Business Program']);
  const l = wrapLabel('Economically Disadvantaged Women-Owned Small Business (EDWOSB) Program', 24);
  assert.equal(l.length, 2);
  assert.ok(l[1].endsWith('…') && l[1].length <= 24);
  assert.deepEqual(wrapLabel('Supercalifragilisticexpialidocious', 10), ['Supercali…']);
});
