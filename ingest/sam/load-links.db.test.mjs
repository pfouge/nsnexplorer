// Round trip: attachment links of a SAM.gov notice reach pub.solicitations.raw, a key in a link does not.
// Needs a migrated scratch database; skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://user@host/db node --test ingest/sam/load-links.db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const dbTest = url ? test : test.skip;

const FILE = 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/0123456789abcdef0123456789abcdef/download';

dbTest('loadSamSolicitations keeps resourceLinks in raw and redacts a key value', async () => {
  const { loadSamSolicitations } = await import('./load.mjs');
  const { getPool, closePool } = await import('../../shared/db.mjs');
  const pool = getPool();
  const rec = (n, links) => ({
    noticeId: `n${n}`, title: 'Test notice', solicitationNumber: `SEED-LINKS-${n}`, postedDate: '2026-11-01',
    responseDeadLine: '2099-01-01T12:00:00-05:00', active: 'Yes', classificationCode: '5340',
    uiLink: `https://sam.gov/opp/n${n}/view`, resourceLinks: links,
  });
  try {
    await loadSamSolicitations([rec(1, null), rec(2, [FILE]), rec(3, [`${FILE}?api_key=null&token=`, `${FILE}x?api_key=TOPSECRET99`])], { pool });
    const { rows } = await pool.query(`select sol_number, raw -> 'resourceLinks' as links, raw::text as t from pub.solicitations where sol_number like 'SEED-LINKS-%' order by 1`);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].links, null);
    assert.deepEqual(rows[1].links, [FILE]);
    assert.deepEqual(rows[2].links, [`${FILE}?api_key=null&token=`, `${FILE}x?api_key=REDACTED`]);
    assert.ok(rows.every((r) => !r.t.includes('TOPSECRET99')));
  } finally {
    await pool.query(`delete from pub.solicitations where sol_number like 'SEED-LINKS-%'`);
    await closePool();
  }
});
