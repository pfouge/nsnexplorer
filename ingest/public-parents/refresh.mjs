#!/usr/bin/env node
// ingest/public-parents/refresh.mjs
// Refreshes pub.public_companies from the spotthemoney.com database (read-only login in
// STM_DATABASE_URL): latest annual revenue from 10-K filings, the three latest 8-K filings and
// federal lobbying reported for the current year. Then rebuilds pub.supplier_parent from the
// reviewed rules in pub.parent_rules. Without STM_DATABASE_URL it only rebuilds the map, so the
// facts loaded by migration 0026 stay as they were.
//
// Usage: DATABASE_URL=... [STM_DATABASE_URL=...] node ingest/public-parents/refresh.mjs
import pg from 'pg';
import { sslFor } from '../../shared/db.mjs';

const nsnUrl = process.env.DATABASE_URL;
if (!nsnUrl) throw new Error('DATABASE_URL is required');
const nsn = new pg.Client({ connectionString: nsnUrl, ssl: sslFor(nsnUrl) });
await nsn.connect();

const stmUrl = process.env.STM_DATABASE_URL;
if (stmUrl) {
  const stm = new pg.Client({ connectionString: stmUrl, ssl: sslFor(stmUrl) });
  await stm.connect();
  const { rows: companies } = await nsn.query('SELECT cik, ticker, lobby_pattern FROM pub.public_companies');
  const { rows: [{ year }] } = await stm.query('SELECT max(period_year)::int AS year FROM lobbying');
  for (const c of companies) {
    const rev = await stm.query(
      `SELECT value, period_end FROM company_financials
       WHERE cik = $1 AND concept = 'revenue' AND fp = 'FY' AND form LIKE '10-K%' AND period_start <= period_end - 300
       ORDER BY period_end DESC, filed DESC LIMIT 1`, [c.cik]);
    const ev = await stm.query(
      `SELECT filed, items, source_url FROM company_events WHERE cik = $1 AND form = '8-K' ORDER BY filed DESC LIMIT 3`, [c.cik]);
    const events = ev.rows.map((e) => ({
      filed: e.filed instanceof Date ? e.filed.toISOString().slice(0, 10) : e.filed,
      item: (e.items || []).find((i) => i !== '9.01') ?? '9.01',
      url: e.source_url,
    }));
    let lobbying = null;
    if (c.lobby_pattern) {
      const lb = await stm.query(
        'SELECT sum(amount) AS amt FROM lobbying WHERE period_year = $1 AND upper(client) ~ $2', [year, c.lobby_pattern]);
      lobbying = lb.rows[0].amt;
    }
    // Keep the last known revenue when SEC data is stale (older than two fiscal years).
    const r = rev.rows[0];
    const fresh = r && new Date(r.period_end) >= new Date(Date.now() - 2 * 365 * 864e5);
    await nsn.query(
      `UPDATE pub.public_companies SET
         revenue = CASE WHEN $2::boolean THEN $3::numeric ELSE revenue END,
         revenue_period_end = CASE WHEN $2::boolean THEN $4::date ELSE revenue_period_end END,
         events = CASE WHEN jsonb_array_length($5::jsonb) > 0 THEN $5::jsonb ELSE events END,
         lobbying_year = $6, lobbying_year_label = $7, as_of = CURRENT_DATE
       WHERE cik = $1`,
      [c.cik, Boolean(fresh), r?.value ?? null, r?.period_end ?? null, JSON.stringify(events), lobbying, String(year)]);
  }
  await stm.end();
  console.log(`refreshed ${companies.length} public companies from spotthemoney (lobbying year ${year})`);
} else {
  console.log('STM_DATABASE_URL not set: facts unchanged, rebuilding the supplier map only');
}

const { rows: [{ n }] } = await nsn.query('SELECT pub.rebuild_supplier_parent() AS n');
console.log(`supplier_parent: ${n} supplier codes tied to a public parent`);
await nsn.end();
