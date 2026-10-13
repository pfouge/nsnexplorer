// node:test suite for load.mjs: streaming a ZIP, filtering to known CAGEs, layout-drift abort.
// The database part needs a migrated scratch DB and only runs when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/gpx_supa node --test ingest/sam-entities/load.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { openExtract, readExtract, loadSamEntities } from './load.mjs';
import { makeZip } from './fixtures/zip.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'SAM_PUBLIC_MONTHLY_V2_20261004.dat';
const dat = readFileSync(path.join(dir, 'fixtures', NAME), 'utf8');
const tmp = mkdtempSync(path.join(tmpdir(), 'samload-'));
const zipPath = path.join(tmp, 'SAM_PUBLIC_MONTHLY_V2_20261004.ZIP');
writeFileSync(zipPath, makeZip({ [NAME]: dat }));

test('streams the .dat out of a ZIP and keeps only wanted CAGEs, with counted skips', async () => {
  const { stream, done } = await openExtract(zipPath);
  const logs = [];
  const { rows, counts } = await readExtract(stream, new Set(['1ABC2', '3DEF4']), 'x.ZIP', { log: (s) => logs.push(s) });
  await done();
  assert.deepEqual(rows.map((r) => r.cage), ['1ABC2', '3DEF4']);
  assert.equal(counts.malformed, 1);
  assert.equal(counts.not_ours, 1);
  assert.equal(counts.header, 1);
  assert.equal(counts.trailer, 1);
  assert.equal(logs.filter((l) => l.startsWith('warn:')).length, 1);
  assert.ok(!logs.join('\n').includes('BOF-NOT')); // the bad line's content is not logged
});

test('a ZIP with no data-like entry is an error that names the entries', async () => {
  const p = path.join(tmp, 'empty.zip');
  writeFileSync(p, makeZip({ 'readme.pdf': 'x', 'layout.xml': 'y' }));
  await assert.rejects(openExtract(p), /no data entry \(entries: .*readme\.pdf/);
});

test('a ZIP whose data file is .txt, or the only entry, or a nested ZIP still opens', async () => {
  const read = async (s) => { let t = ''; for await (const c of s.stream) t += c; await s.done(); return t; };
  const a = path.join(tmp, 'txt.zip');
  writeFileSync(a, makeZip({ 'SAM_PUBLIC_MONTHLY_V2_20261013.txt': 'hello' }));
  assert.equal(await read(await openExtract(a)), 'hello');
  const b = path.join(tmp, 'only.zip');
  writeFileSync(b, makeZip({ 'SAM_PUBLIC_MONTHLY_V2_20261013': 'only' }));
  assert.equal(await read(await openExtract(b)), 'only');
  const c = path.join(tmp, 'nested.zip');
  writeFileSync(c, makeZip({ 'inner.zip': makeZip({ 'x.dat': 'nested' }) }));
  assert.equal(await read(await openExtract(c)), 'nested');
});

test('layout drift (most lines malformed) aborts before anything is written', async () => {
  const junk = Array.from({ length: 600 }, (_, i) => `a|b|c|${i}|!end`).join('\n');
  await assert.rejects(readExtract(Readable.from([junk]), new Set(['1ABC2']), 'x'), /layout drift/);
});

const url = process.env.TEST_DATABASE_URL;
test('loads into pub.supplier_sam and copies the UEI (needs TEST_DATABASE_URL)', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const before = (await pool.query(`SELECT cage, uei FROM pub.suppliers WHERE cage IN ('1ABC2', '3DEF4')`)).rows;
  try {
    await pool.query(`DELETE FROM pub.supplier_sam WHERE cage IN ('1ABC2', '3DEF4')`);
    const r1 = await loadSamEntities({ file: zipPath, pool, log: () => {} });
    assert.equal(r1.upserted, 2);
    const again = await loadSamEntities({ file: zipPath, pool, log: () => {} });
    assert.equal(again.upserted, 2); // idempotent
    assert.equal(again.uei_updated, 0);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pub.supplier_sam WHERE cage IN ('1ABC2', '3DEF4')`);
    assert.equal(rows[0].n, 2);
    const uei = await pool.query(`SELECT uei FROM pub.suppliers WHERE cage = '1ABC2'`);
    assert.equal(uei.rows[0].uei, 'ABCDEFGH1234');
  } finally {
    await pool.query(`DELETE FROM pub.supplier_sam WHERE cage IN ('1ABC2', '3DEF4')`);
    for (const b of before) await pool.query(`UPDATE pub.suppliers SET uei = $2 WHERE cage = $1`, [b.cage, b.uei]);
    await pool.end();
  }
});
