// ingest/test/sol-clean-migration.test.mjs
// Proves that the SQL normaliser in db/migrations/0019_clean_solicitation_number_marker.sql (pg_temp.sol_clean) gives
// the same answer as the parser's cleanSolicitation() (ingest/dibbs/parse.mjs), so the migration renames old rows to
// exactly the number the fixed parser writes.
//
//  1. DB-free: the regular expression and the trim set are lifted out of the migration text and run as JavaScript
//     against cleanSolicitation() on hand-picked samples and on every UTF-16 code unit used as whitespace. This proves the
//     SQL text carries the same rule (a JS regex built from the SQL's own pattern); it cannot prove PostgreSQL's engine.
//  2. DB-backed (only when TEST_DATABASE_URL is set, any migrated scratch database, nothing is written):
//     the real SQL function runs in PostgreSQL over the same inputs and is compared one by one.
//
//   TEST_DATABASE_URL='postgresql://postgres@localhost/gpx_solfix?host=/var/run/postgresql' node --test ingest/test/sol-clean-migration.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSolicitation } from '../dibbs/parse.mjs';

const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations/0019_clean_solicitation_number_marker.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const block = sql.slice(sql.indexOf('-- sol_clean:begin'), sql.indexOf('-- sol_clean:end'));
assert.ok(block.includes('CREATE OR REPLACE FUNCTION pg_temp.sol_clean'), 'sol_clean block not found in the migration');

// E'...' literals of the block, in order: [0] the regexp_replace pattern, [1] the btrim character set.
const literals = [...block.matchAll(/E'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
assert.equal(literals.length, 2, 'expected the pattern and the trim set as the only E-string literals');
const pattern = literals[0].replace(/\\\\/g, '\\'); // E-string: a doubled backslash is one backslash
const trimSet = new Set([...literals[1].matchAll(/\\u([0-9a-f]{4})/g)].map((m) => String.fromCharCode(parseInt(m[1], 16))));
assert.equal(literals[1].replace(/\\u[0-9a-f]{4}/g, ''), '', 'trim set holds only \\uXXXX escapes');
const re = new RegExp(pattern);

/** The migration's rule, executed in JavaScript from the migration's own text. */
function sqlRuleInJs(t) {
  if (t === null || t === undefined) return null;
  let s = String(t).replace(re, '');
  let a = 0;
  let b = s.length;
  while (a < b && trimSet.has(s[a])) a += 1;
  while (b > a && trimSet.has(s[b - 1])) b -= 1;
  s = s.slice(a, b);
  return s.length > 0 ? s : null;
}

const WS_SAMPLES = [' ', '  ', '\t', ' ', ' ', '　', '﻿', ' ', '\n', '\r\n', '  \t'];
const SAMPLES = [
  'SPE1C1-26-Q-0487 --', 'SPE7M5-27-Q-0118 --', 'SPE1C1-26-Q-0334 --', 'SPE1C1-26-Q-0487', 'SPE1C126Q0487',
  'SPE1C126Q0487--', 'SPE1C126Q0487 ---', 'SPE1C126Q0487 - -', 'SPE1C126Q0487 -', 'SPE1C126Q0487 –', 'SPE1C126Q0487 —',
  '  SPE1C126Q0487  -- ', '--', ' -- ', '---', '-', '', ' ', '--SPE1C1', 'SPE--1C1-26-Q-0487', 'SPE1C1-26-Q-0487 -- --',
  'SPE1C1-26-Q-0487 --x', 'a -- b --', 'a\n--\n', 'SPE1C1-26-Q-0487 -- ', ' SPE1C1 --', 'SAMNUMBER123',
  ...WS_SAMPLES.flatMap((w) => [`SPE1C1-26-Q-0487${w}--`, `SPE1C1-26-Q-0487--${w}`, `${w}SPE1C1-26-Q-0487${w}`, `SPE1C1-26-Q-0487${w}--${w}`, `X${w}${w}---${w}`]),
];
// every code unit as the whitespace around a marker (surrogates and NUL excluded: PostgreSQL text cannot hold them)
const CODE_UNITS = [];
for (let c = 1; c <= 0xffff; c += 1) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCharCode(c);
  CODE_UNITS.push(`A${ch}--`, `A--${ch}`, `${ch}A${ch}`, `A${ch}${ch}-${ch}-`);
}

test('0019 SQL rule (run as JS from the migration text) equals cleanSolicitation on samples', () => {
  for (const s of SAMPLES) assert.equal(sqlRuleInJs(s), cleanSolicitation(s), JSON.stringify(s));
  assert.equal(sqlRuleInJs(null), null);
});

test('0019 SQL rule equals cleanSolicitation for every code unit used as whitespace', () => {
  let diff = 0;
  for (const s of CODE_UNITS) {
    if (sqlRuleInJs(s) !== cleanSolicitation(s)) {
      diff += 1;
      if (diff <= 5) assert.fail(`differs on ${JSON.stringify(s)}: ${JSON.stringify(sqlRuleInJs(s))} vs ${JSON.stringify(cleanSolicitation(s))}`);
    }
  }
  assert.equal(diff, 0);
});

test('0019 the examples of the incident come out clean and clean numbers stay as they are', () => {
  assert.equal(cleanSolicitation('SPE7M5-27-Q-0118 --'), 'SPE7M5-27-Q-0118');
  assert.equal(cleanSolicitation('SPE1C1-26-Q-0334 --'), 'SPE1C1-26-Q-0334');
  assert.equal(cleanSolicitation('SPE7M5-27-Q-0118'), 'SPE7M5-27-Q-0118');
  assert.equal(cleanSolicitation('--'), null); // the migration leaves such a row alone
});

const url = process.env.TEST_DATABASE_URL;
const dbTest = url ? test : test.skip;

dbTest('0019 sol_clean in PostgreSQL equals cleanSolicitation on samples and on every code unit', async () => {
  process.env.DATABASE_URL = url;
  const { getPool, closePool } = await import('../../shared/db.mjs');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(block); // CREATE FUNCTION pg_temp.sol_clean, taken verbatim from the migration
    const inputs = [...SAMPLES, ...CODE_UNITS];
    let checked = 0;
    for (let i = 0; i < inputs.length; i += 5000) {
      const chunk = inputs.slice(i, i + 5000);
      const { rows } = await client.query('SELECT i, pg_temp.sol_clean(t) AS r FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY i', [chunk]);
      assert.equal(rows.length, chunk.length);
      rows.forEach((row, k) => {
        assert.equal(row.r, cleanSolicitation(chunk[k]), JSON.stringify(chunk[k]));
        checked += 1;
      });
    }
    assert.equal(checked, inputs.length);
    assert.equal((await client.query('SELECT pg_temp.sol_clean(NULL) AS r')).rows[0].r, null);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
