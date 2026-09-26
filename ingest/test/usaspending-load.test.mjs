import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../../shared/db.mjs';
import { loadRecord, fscName, itemNameFromDescription, FSC_NAMES } from '../usaspending/load.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'usaspending', 'fixtures', 'sample.jsonl');
const PSC = '5331';

test('fscName: known FSC returns built-in map name', () => {
  assert.equal(fscName('5331'), 'O-Rings');
  assert.equal(fscName('5330'), 'Packing and Gasket Materials');
  assert.equal(fscName('5306'), 'Bolts');
  assert.equal(fscName('5305'), 'Screws');
});

test('fscName: unknown FSC falls back to "FSC <code>"', () => {
  assert.equal(fscName('9999'), 'FSC 9999');
});

test('itemNameFromDescription: takes text after "!"', () => {
  assert.equal(itemNameFromDescription('5331002915924!O-RING SEAL STATIC'), 'O-RING SEAL STATIC');
});

test('itemNameFromDescription: null when no "!" present', () => {
  assert.equal(itemNameFromDescription('NO BANG HERE'), null);
});

test('itemNameFromDescription: null for empty/missing input', () => {
  assert.equal(itemNameFromDescription(''), null);
  assert.equal(itemNameFromDescription(null), null);
});

// Live-DB fixture load: runs against the local gpx database (no mocking),
// inserts 3 fixture contract_actions rows, verifies the resulting counts
// and parsed NSNs, then deletes everything it created — including any
// pub.nsns/pub.agencies rows it created — leaving pub.fsc config rows in
// place. If this test is interrupted the `after` hook still cleans up.
test('loadRecord: 3-record USAspending fixture round-trips against local DB', async (t) => {
  const text = await readFile(FIXTURE_PATH, 'utf8');
  const records = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(records.length, 3, 'fixture should have exactly 3 records');

  const awardUids = records.map((r) => r.generated_internal_id);
  const pool = getPool();

  const cleanup = async () => {
    await pool.query(`DELETE FROM pub.contract_actions WHERE award_uid = ANY($1)`, [awardUids]);
    await pool.query(`DELETE FROM pub.nsns WHERE nsn IN ('5331002915924', '5331012345678')`);
    // Only remove the agency row if nothing else references it — the local
    // DB may hold real loaded data that shares the same DLA agency row.
    await pool.query(
      `DELETE FROM pub.agencies a
       WHERE a.name = 'Defense Logistics Agency'
         AND a.toptier_code IS NULL AND a.subtier_code IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pub.contract_actions ca WHERE ca.agency_id = a.agency_id
         )`
    );
  };

  t.after(cleanup);
  await cleanup(); // in case a prior interrupted run left rows behind

  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pub.contract_actions WHERE award_uid = ANY($1)`,
    [awardUids]
  );
  assert.equal(before.rows[0].n, 0, 'fixture rows should not pre-exist');

  const results = [];
  for (const record of records) {
    results.push(await loadRecord(record, PSC));
  }

  assert.equal(results.filter((r) => r.inserted).length, 3, 'all 3 fixture records should insert');
  assert.equal(results[0].nsn, '5331002915924', 'record 1: plain 13-digit NSN parsed');
  assert.equal(results[1].nsn, null, 'record 2: 10-digit PR-number trap must not parse as NSN');
  assert.equal(results[2].nsn, '5331012345678', 'record 3: dashed NSN parsed');

  const after1 = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pub.contract_actions WHERE award_uid = ANY($1)`,
    [awardUids]
  );
  assert.equal(after1.rows[0].n, 3, 'exactly 3 contract_actions rows present after load');

  const nsnRows = await pool.query(
    `SELECT nsn, fsc, item_name FROM pub.nsns WHERE nsn IN ('5331002915924', '5331012345678') ORDER BY nsn`
  );
  assert.equal(nsnRows.rowCount, 2);
  assert.equal(nsnRows.rows[0].item_name, 'O-RING SEAL STATIC');

  // Idempotency: re-loading the same records must not create duplicates
  // (ON CONFLICT (award_uid, action_date) DO NOTHING).
  for (const record of records) {
    await loadRecord(record, PSC);
  }
  const after2 = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pub.contract_actions WHERE award_uid = ANY($1)`,
    [awardUids]
  );
  assert.equal(after2.rows[0].n, 3, 'reload is idempotent, still exactly 3 rows');

  await cleanup();

  const finalCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pub.contract_actions WHERE award_uid = ANY($1)`,
    [awardUids]
  );
  assert.equal(finalCount.rows[0].n, 0, 'fixture rows fully removed after cleanup');
});

after(async () => {
  await closePool();
});
