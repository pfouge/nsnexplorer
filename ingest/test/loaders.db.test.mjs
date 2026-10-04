// ingest/test/loaders.db.test.mjs
// Database-backed tests for the DIBBS loaders' write path: supplier stubs
// before price points, batched award loads, idempotency, and two lanes
// writing the same NSNs at once. Needs a migrated scratch database, so it
// only runs when TEST_DATABASE_URL is set (skipped otherwise):
//
//   TEST_DATABASE_URL=postgresql://root@127.0.0.1:5432/gpx_test node --test ingest/test/loaders.db.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const { getPool, closePool, withRetry, isRetryable } = await import('../../shared/db.mjs');
const {
  loadAwardGridActions,
  loadRfqSolicitations,
  loadPricePointsFromAwards,
} = await import('../dibbs/load.mjs');
const { evaluateSource } = await import('../../db/freshness.mjs');

test('withRetry: retries a deadlock, gives up on a real error', async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return 'done';
    },
    { baseMs: 1 }
  );
  assert.equal(out, 'done');
  assert.equal(calls, 3);

  let fkCalls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        fkCalls += 1;
        throw Object.assign(new Error('fk'), { code: '23503' });
      },
      { baseMs: 1 }
    ),
    /fk/
  );
  assert.equal(fkCalls, 1);
  assert.equal(isRetryable({ code: '40P01' }), true);
  assert.equal(isRetryable({ code: '23503' }), false);
});

test('evaluateSource: flags stale and never-landed sources', () => {
  const now = new Date('2026-10-04T22:00:00Z');
  const src = { key: 'x', label: 'x', maxAgeHours: 48 };
  assert.equal(evaluateSource(src, { last_landed: '2026-10-04T10:00:00Z', rows: '5' }, now).status, 'ok');
  assert.equal(evaluateSource(src, { last_landed: '2026-10-01T10:00:00Z', rows: '5' }, now).status, 'STALE');
  assert.equal(evaluateSource(src, { last_landed: null, rows: '0' }, now).status, 'STALE');
});

const dbTest = url ? test : test.skip;

const pad = (n, w) => String(n).padStart(w, '0');
const nsnOf = (i) => `5331${pad(i, 9)}`;

function rfqRecord(i, today) {
  // Shape of a parseRfqGrid record (see map-rfq.mjs).
  return {
    solicitation: `SPE7M1-26-T-${pad(i, 4)}`,
    nsnRaw: nsnOf(i),
    nomenclature: 'O-RING',
    quantity: 10,
    issued: today,
    returnBy: '2099-01-01',
    purchaseRequest: `PR${pad(i, 8)}`,
  };
}

function awardRecord(i, { cage = '1ABC2' } = {}) {
  return {
    awardNumber: `SPE7M126V${pad(i, 4)}`,
    deliveryOrder: null,
    cage,
    total: 500,
    awardDate: '2026-09-30',
    postedDate: '2026-10-01',
    nsnRaw: nsnOf(i),
    nomenclature: 'O-RING',
    purchaseRequest: `PR${pad(i, 8)}`,
    solicitation: `SPE7M126T${pad(i, 4)}`,
  };
}

dbTest('loaders against a real database', async (t) => {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `TRUNCATE pub.price_points, pub.contract_actions, pub.solicitations, pub.part_numbers,
              pub.amsc_observations, ops.targets, pub.nsns, pub.suppliers, pub.fsc CASCADE`
  );
  await pool.query(`INSERT INTO pub.fsc (fsc, name, render_depth) VALUES ('5331', 'O-Ring', 'deep')`);

  await t.test('RFQ load stores solicitations and grows the catalog', async () => {
    const recs = Array.from({ length: 1200 }, (_, i) => rfqRecord(i + 1, today));
    const r = await loadRfqSolicitations(recs, { pool, today });
    assert.equal(r.loaded, 1200, JSON.stringify(r.skipReasons));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pub.nsns`);
    assert.equal(rows[0].n, 1200);
  });

  await t.test('price join creates the missing supplier instead of failing the FK', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM pub.suppliers WHERE cage = '4U0A9'`);
    assert.equal(before.rows[0].n, 0);
    const awards = [awardRecord(1, { cage: '4U0A9' }), awardRecord(2, { cage: '4U0A9' }), awardRecord(3, { cage: null })];
    const r = await loadPricePointsFromAwards(awards, { pool });
    assert.equal(r.loaded, 3, JSON.stringify(r));
    const pp = await pool.query(`SELECT nsn, unit_price::float AS p, cage FROM pub.price_points ORDER BY nsn`);
    assert.equal(pp.rows.length, 3);
    assert.equal(pp.rows[0].p, 50); // 500 total / quantity 10 from the retained RFQ
    assert.equal(pp.rows[0].cage, '4U0A9');
    const after = await pool.query(`SELECT count(*)::int AS n FROM pub.suppliers WHERE cage = '4U0A9'`);
    assert.equal(after.rows[0].n, 1);
    // Re-running the same awards is a no-op, not a duplicate.
    await loadPricePointsFromAwards(awards, { pool });
    const again = await pool.query(`SELECT count(*)::int AS n FROM pub.price_points`);
    assert.equal(again.rows[0].n, 3);
  });

  await t.test('award grid load is batched, deduplicated and idempotent', async () => {
    await pool.query(`UPDATE pub.suppliers SET name = 'ACME SEALS' WHERE cage = '4U0A9'`);
    const recs = [];
    for (let i = 1; i <= 1500; i += 1) recs.push(awardRecord(i, { cage: i % 2 ? '4U0A9' : '9ZZZ9' }));
    recs.push(awardRecord(7, { cage: '4U0A9' })); // same award seen on two grid pages
    recs.push({ ...awardRecord(9999), nsnRaw: 'not-an-nsn' });
    const r = await loadAwardGridActions(recs);
    assert.equal(r.skipped.length, 1);
    const ca = await pool.query(
      `SELECT count(*)::int AS n, count(recipient_name)::int AS named FROM pub.contract_actions WHERE award_uid LIKE 'DIBBS-%'`
    );
    assert.equal(ca.rows[0].n, 1500);
    assert.equal(ca.rows[0].named, 750); // only the CAGE with a known name
    const nsns = await pool.query(`SELECT count(*)::int AS n FROM pub.nsns`);
    assert.equal(nsns.rows[0].n, 1500); // 300 new NSNs beyond the RFQ set
    await loadAwardGridActions(recs);
    const ca2 = await pool.query(`SELECT count(*)::int AS n FROM pub.contract_actions`);
    assert.equal(ca2.rows[0].n, 1500);
  });

  await t.test('award and RFQ lanes can write the same NSNs at the same time', async () => {
    // Opposite input orders over the same 4,000 NSNs: this is the pattern
    // that deadlocked in production (40P01 on pub.nsns).
    const n = 4000;
    const awards = Array.from({ length: n }, (_, i) => awardRecord(n - i));
    const rfqs = Array.from({ length: n }, (_, i) => rfqRecord(i + 1, today));
    for (let round = 0; round < 3; round += 1) {
      const [a, b, c] = await Promise.all([
        loadAwardGridActions(awards),
        loadRfqSolicitations(rfqs, { pool, today }),
        loadAwardGridActions([...awards].reverse()),
      ]);
      assert.equal(a.loaded, n);
      assert.equal(b.loaded, n);
      assert.equal(c.loaded, n);
    }
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pub.nsns`);
    assert.equal(rows[0].n, n);
  });

  await closePool();
});
