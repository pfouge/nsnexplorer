import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAME_QUERY_MAX_CHARS,
  alsoCalledFor,
  clampInt,
  demandLabel,
  displayName,
  hitMeta,
  monthYearLabel,
  nameQueryProblem,
  parseNameQuery,
  rowsFromParam,
  searchPageUrl,
} from './item-search.ts';
import { shapeNameRows } from './item-search-result.ts';

const ok = (raw: string) => {
  const q = parseNameQuery(raw);
  assert.equal(q.ok, true, `expected ${JSON.stringify(raw)} to parse`);
  return q as Extract<typeof q, { ok: true }>;
};

test('plain words become lower-case words, a reversed phrase and padded word slots', () => {
  const q = ok('Lock  Washer');
  assert.equal(q.phrase, 'lock washer');
  assert.equal(q.reversed, 'washer lock');
  assert.deepEqual(q.words, ['lock', 'washer', null, null]);
});

test('hyphens and commas split words, so "o-ring" and the catalog "WASHER,LOCK" compare alike', () => {
  const o = ok('o-ring');
  assert.equal(o.phrase, 'o ring');
  assert.equal(o.reversed, 'ring o');
  assert.deepEqual(o.words, ['ring', null, null, null]); // "o" is too short to narrow the search
  assert.equal(ok('washer,lock').phrase, 'washer lock');
});

test('LIKE wildcards, quotes, backslashes and SQL text cannot survive', () => {
  for (const raw of ["100%", 'a_b_c', "x' OR '1'='1", 'back\\slash', '"; DROP TABLE pub.nsns; --', 'wash%er', '%%%washer___']) {
    const q = parseNameQuery(raw);
    if (!q.ok) continue;
    for (const piece of [q.phrase, q.reversed, ...q.words]) {
      if (piece !== null) assert.match(piece, /^[a-z0-9 ]+$/, `${JSON.stringify(raw)} leaked ${JSON.stringify(piece)}`);
    }
  }
  assert.equal(ok('wash%er').phrase, 'wash er');
  assert.equal(ok("o'ring seal").phrase, 'o ring seal');
});

test('empty, short and number-only queries are refused with a reason', () => {
  assert.deepEqual(parseNameQuery(''), { ok: false, reason: 'empty' });
  assert.deepEqual(parseNameQuery('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(parseNameQuery(null), { ok: false, reason: 'empty' });
  assert.deepEqual(parseNameQuery('%_%'), { ok: false, reason: 'empty' });
  assert.deepEqual(parseNameQuery('a'), { ok: false, reason: 'short' });
  assert.deepEqual(parseNameQuery('ab'), { ok: false, reason: 'short' });
  assert.deepEqual(parseNameQuery('a b c'), { ok: false, reason: 'short' });
  assert.deepEqual(parseNameQuery('5340-01-396-7260'), { ok: false, reason: 'no_letters' });
  assert.equal(ok('abc').words[0], 'abc');
});

test('a very long query is cut to the cap and at most four words are used', () => {
  const q = ok('washer '.repeat(100));
  assert.ok(q.phrase.length <= NAME_QUERY_MAX_CHARS);
  assert.equal(q.words.length, 4);
  const many = ok('alpha beta gamma delta epsilon zeta');
  assert.deepEqual(many.words, ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(many.phrase, 'alpha beta gamma delta');
  assert.ok(ok('x'.repeat(5000)).phrase.length <= NAME_QUERY_MAX_CHARS);
});

test('accents and unicode are folded or dropped', () => {
  assert.equal(ok('Crêpe  Ring').phrase, 'crepe ring');
  assert.equal(parseNameQuery('\u0000‮​').ok, false);
  assert.equal(ok('ring\u0000\u0007seal').phrase, 'ring seal');
});

test('non-string input is handled', () => {
  assert.equal(parseNameQuery(undefined).ok, false);
  assert.equal(parseNameQuery(12345).ok, false);
  assert.equal(ok(['lock', 'washer'] as unknown as string).phrase, 'lock washer');
});

test('nameQueryProblem has plain text and no em dash', () => {
  for (const r of ['empty', 'short', 'no_letters'] as const) {
    const t = nameQueryProblem(r);
    assert.ok(t.length > 10);
    assert.ok(!t.includes('\u2014'));
  }
});

test('clampInt and rowsFromParam', () => {
  assert.equal(clampInt('7', 1, 0, 10), 7);
  assert.equal(clampInt('99', 1, 0, 10), 10);
  assert.equal(clampInt('-3', 4, 0, 10), 4);
  assert.equal(clampInt('abc', 4, 0, 10), 4);
  assert.equal(clampInt(null, 4, 0, 10), 4);
  assert.equal(clampInt('1e3', 4, 0, 10), 4);
  assert.equal(rowsFromParam(undefined), 25);
  assert.equal(rowsFromParam('50'), 50);
  assert.equal(rowsFromParam('51'), 75);
  assert.equal(rowsFromParam('100000'), 200);
  assert.equal(rowsFromParam('0'), 25);
  assert.equal(rowsFromParam('nope'), 25);
});

test('searchPageUrl carries only the search text (and the row count when above one page)', () => {
  assert.equal(searchPageUrl('lock washer'), '/search/?q=lock%20washer');
  assert.equal(searchPageUrl(' o-ring ', 50), '/search/?q=o-ring&n=50');
  assert.equal(searchPageUrl('a&b=c'), '/search/?q=a%26b%3Dc');
  assert.ok(searchPageUrl('x'.repeat(500)).length < 120);
});

test('demand and date labels', () => {
  assert.equal(monthYearLabel('2026-03-14'), 'Mar 2026');
  assert.equal(monthYearLabel('2026-03-14T00:00:00.000Z'), 'Mar 2026');
  assert.equal(monthYearLabel(null), null);
  assert.equal(monthYearLabel('garbage'), null);
  assert.equal(monthYearLabel('2026-13-01'), null);
  assert.equal(demandLabel(1, null), '1 open solicitation');
  assert.equal(demandLabel(3, '2026-01-01'), '3 open solicitations');
  assert.equal(demandLabel(0, '2026-03-14'), 'Last award Mar 2026');
  assert.equal(demandLabel(0, null), '');
  assert.equal(hitMeta({ fsc: '5310', fscName: 'Nuts and Washers', open: 2, lastAward: null }), 'Class 5310 Nuts and Washers · 2 open solicitations');
  assert.equal(hitMeta({ fsc: '5310', fscName: null, open: 0, lastAward: null }), 'Class 5310');
});

test('displayName title-cases catalog names the way the NSN page does', () => {
  assert.equal(displayName('WASHER,LOCK'), 'Washer, Lock');
  assert.equal(displayName('GRIP  WASHER'), 'Grip Washer');
  assert.equal(displayName('O-RING'), 'O-Ring');
  assert.equal(displayName('BOLT,MACHINE,5/8-11'), 'Bolt, Machine, 5/8-11');
  assert.equal(displayName(null), 'Unnamed item');
  assert.equal(displayName('  '), 'Unnamed item');
  assert.equal(displayName('WASHER,'), 'Washer');
});

test('shapeNameRows dashes the NSN, trims types and reports whether more rows exist', () => {
  const rows = [
    { nsn: '5310003138277', item_name: 'WASHER,LOCK', fsc: '5310', fsc_name: 'Nuts and Washers', also_called: 'GRIP WASHER', tier: 0, open_n: 2, last_award: '2026-02-20', total: 60 },
    { nsn: '5310003143213', item_name: null, fsc: '5310', fsc_name: null, also_called: null, tier: 3, open_n: 0, last_award: new Date('2025-04-16T00:00:00Z'), total: 60 },
  ];
  const r = shapeNameRows('lock washer', rows, 25);
  assert.equal(r.ok, true);
  assert.equal(r.total, 60);
  assert.equal(r.more, true);
  assert.equal(r.results[0].nsn, '5310-00-313-8277');
  assert.equal(r.results[0].alsoCalled, 'GRIP WASHER');
  assert.equal(r.results[0].lastAward, '2026-02-20');
  assert.equal(r.results[1].name, '');
  assert.equal(r.results[1].lastAward, '2025-04-16');
  assert.equal(shapeNameRows('x', [], 0).more, false);
  assert.equal(shapeNameRows('x', rows.slice(0, 1).map((x) => ({ ...x, total: 1 })), 0).more, false);
});

test('alsoCalledFor hides an everyday name that adds no words and keeps one that does', () => {
  assert.equal(alsoCalledFor('WASHER,LOCK', 'GRIP WASHER'), 'GRIP WASHER');
  assert.equal(alsoCalledFor('WASHER,LOCK', 'LOCK WASHER'), null);
  assert.equal(alsoCalledFor('WASHER,LOCK', 'WASHER LOCK'), null);
  assert.equal(alsoCalledFor('WASHER,6 INCH', 'WASHER'), null);
  assert.equal(alsoCalledFor('PACKING,PREFORMED', 'O-RING'), 'O-RING');
  assert.equal(alsoCalledFor(null, 'WIDGET LOCK'), 'WIDGET LOCK');
  assert.equal(alsoCalledFor('WASHER,LOCK', null), null);
  assert.equal(alsoCalledFor('WASHER,LOCK', '  '), null);
  assert.equal(alsoCalledFor('WASHER,LOCK', ' Spring Lock Washer '), 'Spring Lock Washer');
});
