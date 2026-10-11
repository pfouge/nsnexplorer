#!/usr/bin/env node
// Verifies that the on-demand page loaders cost ONE database round-trip each
// and return exactly what the old multi-query loaders returned.
//
//   node web/scripts/verify-single-query.mjs [--db <url>] [--seed] [--keep]
//
//   --db <url>  database to read (default $DATABASE_URL, else the local gpx_w_entity)
//   --tz <zone> (with --seed) set the clone's session time zone, to show results do not depend on it
//   --seed      first clone that database to "<name>_sqverify", load
//               verify-single-query-seed.sql into the clone (edge cases the dev
//               data lacks: 260-award supplier, tied dates, null/blank columns,
//               microsecond timestamps, ...), verify against the clone, drop it
//               afterwards (unless --keep). The original database is only read
//               (CREATE DATABASE ... TEMPLATE needs no other connection to it).
//
// What it checks, per sampled input, for each loader:
//   1. OLD loader (copied verbatim below from the pre-change code) vs NEW loader
//      (bundled straight from web/src/lib): assert.deepStrictEqual (types included:
//      number vs string, null, plain objects) plus identical JSON text (key order).
//   2. Round-trips: every connection goes through a counting TCP proxy that reads
//      the Postgres frontend protocol. Per NEW loader call it asserts exactly one
//      statement (Parse or simple Query message) and one Sync (= one round-trip),
//      i.e. no type-fetch or other hidden queries. The driver's own `debug` hook
//      is cross-checked. The OLD loaders' counts are printed for comparison.
//
// Exit code 0 only when every check passes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../src/lib');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const baseUrl = opt('--db') ?? process.env.DATABASE_URL ?? 'postgresql://root:gpxlocal@127.0.0.1:5432/gpx_w_entity';
const withSeed = flag('--seed');
const keep = flag('--keep');

const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
};
const psql = (url, args, input) =>
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });

// ---------------------------------------------------- bundle the NEW loaders
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqverify-'));
await build({
  stdin: {
    contents: `
      export { loadNsnPage, openSql } from './nsn-page.ts';
      export { loadSupplierPage, SUPPLIER_AWARD_ROWS } from './supplier-page.ts';
      export { loadSolicitationPage } from './solicitation-page.ts';
      export { searchSupplierRows } from './supplier-search.ts';
      export { NSN_WITH_AMSC_SELECT, mapNsnRow, assertSourceUrl, slugify } from './shared.ts';
      export { isSolNumber, parseSupplierQuery } from './entity.ts';`,
    resolveDir: libDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: path.join(tmp, 'new-loaders.mjs'),
  logLevel: 'error',
  // `postgres` is CommonJS-free but pulls Node builtins; keep them external.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const N = await import(pathToFileURL(path.join(tmp, 'new-loaders.mjs')).href);
const { NSN_WITH_AMSC_SELECT, mapNsnRow, assertSourceUrl, slugify, isSolNumber, SUPPLIER_AWARD_ROWS } = N;

// ------------------------------------------------ OLD loaders (copied verbatim)
// Source: web/src/lib/{nsn-page,supplier-page,solicitation-page}.ts at origin/main
// before the single-query change. Only TypeScript annotations were removed.
const isoDateNsn = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10));

async function oldLoadNsnPage(sql, nsnCode) {
  if (!/^\d{13}$/.test(nsnCode)) return null;

  const nsnRows = await sql.unsafe(`${NSN_WITH_AMSC_SELECT} WHERE n.nsn = $1`, [nsnCode]);
  if (nsnRows.length === 0) return null;
  const nsn = mapNsnRow(nsnRows[0]);

  const [fscRows, ppRows, caRows, solRows, pnRows] = await Promise.all([
    sql.unsafe(`SELECT fsc, name, fsg, render_depth FROM pub.fsc WHERE fsc = $1`, [nsn.fsc]),
    sql.unsafe(
      `SELECT pp.id, pp.nsn, pp.awarded_on, pp.unit_price, pp.quantity, pp.total_value,
              pp.cage, s.name AS supplier_name, s.city AS supplier_city, s.state AS supplier_state,
              pp.agency_id, ag.name AS agency_name, ag.abbreviation AS agency_abbr,
              pp.sol_number, pp.award_ref, pp.source, pp.source_url, pp.ingested_at
       FROM pub.price_points pp
       LEFT JOIN pub.suppliers s ON s.cage = pp.cage
       LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
       WHERE pp.nsn = $1
       ORDER BY pp.awarded_on`,
      [nsnCode]
    ),
    sql.unsafe(
      `SELECT ca.id, ca.award_uid, ca.piid, ca.psc, ca.naics, ca.description, ca.action_date,
              ca.obligation, ca.agency_id, ag.name AS agency_name, ca.recipient_name,
              ca.recipient_uei, ca.source_url, ca.ingested_at,
              NULLIF(btrim(ca.raw ->> 'cage'), '') AS cage
       FROM pub.contract_actions ca
       LEFT JOIN pub.agencies ag ON ag.agency_id = ca.agency_id
       WHERE (ca.raw ->> 'nsn') = $1
       ORDER BY ca.action_date`,
      [nsnCode]
    ),
    sql.unsafe(
      // Open means open today: past-dated 'open' rows are reported as 'expired'.
      `SELECT s.sol_number, s.nsn, s.fsc, s.nomenclature, s.quantity, s.unit_of_issue,
              s.issued_on, s.return_by,
              CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
              s.setaside, s.buyer_office, s.source, s.source_url,
              n.item_name
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       WHERE s.nsn = $1
       ORDER BY COALESCE(s.return_by, s.issued_on) DESC NULLS LAST, s.sol_number`,
      [nsnCode]
    ),
    sql.unsafe(
      `SELECT pn.nsn, pn.part_number, pn.cage, pn.source, pn.source_url, s.name AS supplier_name
       FROM pub.part_numbers pn
       LEFT JOIN pub.suppliers s ON s.cage = pn.cage
       WHERE pn.nsn = $1
       ORDER BY pn.part_number`,
      [nsnCode]
    ),
  ]);

  const fsc = fscRows[0]
    ? { fsc: fscRows[0].fsc, name: fscRows[0].name, fsg: fscRows[0].fsg, renderDepth: fscRows[0].render_depth }
    : null;

  const agencyMap = new Map();
  const pricePoints = ppRows.map((r) => {
    const rec = {
      id: Number(r.id),
      nsn: r.nsn,
      awardedOn: isoDateNsn(r.awarded_on),
      unitPrice: Number(r.unit_price),
      quantity: r.quantity !== null ? Number(r.quantity) : null,
      totalValue: r.total_value !== null ? Number(r.total_value) : null,
      cage: r.cage,
      supplierName: r.supplier_name,
      supplierCity: r.supplier_city,
      supplierState: r.supplier_state,
      agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
      agencyName: r.agency_name,
      agencyAbbr: r.agency_abbr,
      solNumber: r.sol_number,
      awardRef: r.award_ref,
      source: r.source,
      sourceUrl: assertSourceUrl(r.source_url, `price_points.id=${r.id} nsn=${r.nsn}`),
      ingestedAt: new Date(r.ingested_at).toISOString(),
    };
    if (rec.agencyId !== null && !agencyMap.has(rec.agencyId)) {
      agencyMap.set(rec.agencyId, {
        agencyId: rec.agencyId,
        name: rec.agencyName ?? `Agency ${rec.agencyId}`,
        abbreviation: rec.agencyAbbr,
        slug: slugify(rec.agencyName ?? `agency-${rec.agencyId}`),
      });
    }
    return rec;
  });

  const contractActions = caRows.map((r) => ({
    id: Number(r.id),
    awardUid: r.award_uid,
    piid: r.piid,
    psc: r.psc,
    naics: r.naics,
    description: r.description,
    actionDate: isoDateNsn(r.action_date),
    obligation: r.obligation !== null ? Number(r.obligation) : null,
    agencyId: r.agency_id !== null ? Number(r.agency_id) : null,
    agencyName: r.agency_name,
    recipientName: r.recipient_name,
    recipientUei: r.recipient_uei,
    sourceUrl: assertSourceUrl(r.source_url, `contract_actions.id=${r.id}`),
    ingestedAt: new Date(r.ingested_at).toISOString(),
    cage: r.cage ?? null,
  }));

  const solicitations = solRows.map((r) => ({
    solNumber: r.sol_number,
    nsn: r.nsn,
    fsc: r.fsc,
    nomenclature: r.nomenclature,
    itemName: r.item_name,
    quantity: r.quantity !== null ? Number(r.quantity) : null,
    unitOfIssue: r.unit_of_issue,
    issuedOn: isoDateNsn(r.issued_on),
    returnBy: isoDateNsn(r.return_by),
    status: r.status,
    setaside: r.setaside,
    buyerOffice: r.buyer_office,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number}`),
  }));

  const partNumbers = pnRows.map((r) => ({
    partNumber: r.part_number,
    cage: r.cage,
    supplierName: r.supplier_name,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `part_numbers ${r.nsn}/${r.part_number}`),
  }));

  return { nsn, fsc, pricePoints, contractActions, solicitations, partNumbers, agencies: [...agencyMap.values()] };
}

const VALUE_SQL = 'COALESCE(pp.total_value, pp.unit_price * pp.quantity)';
const clean = (v) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const isoDateReq = (v) => new Date(v).toISOString().slice(0, 10);

async function oldLoadSupplierPage(sql, cage) {
  if (!/^[A-Z0-9]{5}$/.test(cage)) return null;

  const statRows = await sql.unsafe(
    `SELECT count(*)::int AS awards,
            COALESCE(sum(${VALUE_SQL}), 0) AS dollars,
            count(${VALUE_SQL})::int AS valued,
            count(DISTINCT pp.nsn)::int AS nsns,
            count(DISTINCT n.fsc)::int AS classes,
            min(pp.awarded_on) AS first_award,
            max(pp.awarded_on) AS latest_award,
            max(pp.ingested_at) AS refreshed,
            EXISTS (SELECT 1 FROM pub.part_numbers pn WHERE pn.cage = $1) AS makes_parts
     FROM pub.price_points pp
     JOIN pub.nsns n ON n.nsn = pp.nsn
     WHERE pp.cage = $1`,
    [cage]
  );
  const st = statRows[0];
  if (!st || Number(st.awards) === 0) return null;

  const [supplierRows, awardRows, classRows] = await Promise.all([
    sql.unsafe(`SELECT name, city, state FROM pub.suppliers WHERE cage = $1`, [cage]),
    sql.unsafe(
      `SELECT pp.awarded_on, pp.nsn, n.item_name, pp.quantity, pp.unit_price,
              ${VALUE_SQL} AS total,
              pp.agency_id, ag.name AS agency_name, pp.source, pp.source_url, pp.id
       FROM pub.price_points pp
       JOIN pub.nsns n ON n.nsn = pp.nsn
       LEFT JOIN pub.agencies ag ON ag.agency_id = pp.agency_id
       WHERE pp.cage = $1
       ORDER BY pp.awarded_on DESC, pp.id DESC
       LIMIT ${SUPPLIER_AWARD_ROWS}`,
      [cage]
    ),
    sql.unsafe(
      `SELECT g.fsc, f.name, f.render_depth, g.awards,
              (f.render_depth <> 'excluded' AND g.fsc ~ '^[0-9]{4}$'
               AND EXISTS (SELECT 1 FROM pub.solicitations s WHERE s.fsc = g.fsc)) AS has_open
       FROM (
         SELECT n.fsc, count(*)::int AS awards
         FROM pub.price_points pp
         JOIN pub.nsns n ON n.nsn = pp.nsn
         WHERE pp.cage = $1
         GROUP BY n.fsc
       ) g
       LEFT JOIN pub.fsc f ON f.fsc = g.fsc
       ORDER BY g.awards DESC, g.fsc`,
      [cage]
    ),
  ]);

  const sup = supplierRows[0];
  const rows = awardRows.map((r) => {
    const agencyName = clean(r.agency_name);
    return {
      awardedOn: isoDateReq(r.awarded_on),
      nsn: r.nsn,
      itemName: clean(r.item_name),
      quantity: r.quantity !== null ? Number(r.quantity) : null,
      unitPrice: Number(r.unit_price),
      total: r.total !== null ? Number(r.total) : null,
      agencyName,
      agencySlug: r.agency_id !== null ? slugify(agencyName ?? `agency-${r.agency_id}`) : null,
      source: r.source,
      sourceUrl: assertSourceUrl(r.source_url, `price_points.id=${r.id} cage=${cage}`),
    };
  });

  return {
    cage,
    name: clean(sup?.name),
    city: clean(sup?.city),
    state: clean(sup?.state),
    awards: Number(st.awards),
    dollars: Number(st.dollars),
    valuedAwards: Number(st.valued),
    nsns: Number(st.nsns),
    classes: Number(st.classes),
    firstAward: isoDateReq(st.first_award),
    latestAward: isoDateReq(st.latest_award),
    rows,
    classRows: classRows.map((r) => {
      const name = clean(r.name);
      return {
        fsc: r.fsc,
        name: name === null || name === `FSC ${r.fsc}` ? null : name,
        awards: Number(r.awards),
        link: r.render_depth === 'deep' ? 'fsc' : r.has_open ? 'open' : null,
      };
    }),
    makesParts: st.makes_parts === true,
    refreshedOn: st.refreshed ? new Date(st.refreshed).toISOString().slice(0, 10) : null,
  };
}

async function oldLoadSolicitationPage(sql, solNumber) {
  if (!isSolNumber(solNumber)) return null;

  const [solRows, awardRows] = await Promise.all([
    sql.unsafe(
      `SELECT s.sol_number, s.nsn, s.fsc, s.nomenclature, s.quantity, s.unit_of_issue,
              s.issued_on, s.return_by,
              CASE WHEN s.status = 'open' AND s.return_by < CURRENT_DATE THEN 'expired' ELSE s.status END AS status,
              s.setaside, s.buyer_office, s.source, s.source_url,
              n.item_name, f.name AS fsc_name, f.render_depth AS fsc_depth
       FROM pub.solicitations s
       LEFT JOIN pub.nsns n ON n.nsn = s.nsn
       LEFT JOIN pub.fsc f ON f.fsc = s.fsc
       WHERE s.sol_number = $1`,
      [solNumber]
    ),
    sql.unsafe(
      `SELECT pp.awarded_on, pp.cage, su.name AS supplier_name, pp.unit_price, pp.quantity
       FROM pub.price_points pp
       LEFT JOIN pub.suppliers su ON su.cage = pp.cage
       WHERE pp.sol_number = $1
       ORDER BY pp.awarded_on DESC, pp.id DESC
       LIMIT 100`,
      [solNumber]
    ),
  ]);
  const r = solRows[0];
  if (!r) return null;

  const fscName = typeof r.fsc_name === 'string' && r.fsc_name.trim() !== '' && r.fsc_name !== `FSC ${r.fsc}` ? r.fsc_name.trim() : null;
  const sol = {
    solNumber: r.sol_number,
    nsn: r.nsn,
    fsc: r.fsc,
    nomenclature: r.nomenclature,
    itemName: r.item_name,
    quantity: r.quantity !== null ? Number(r.quantity) : null,
    unitOfIssue: r.unit_of_issue,
    issuedOn: isoDateNsn(r.issued_on),
    returnBy: isoDateNsn(r.return_by),
    status: r.status,
    setaside: r.setaside,
    buyerOffice: r.buyer_office,
    source: r.source,
    sourceUrl: assertSourceUrl(r.source_url, `solicitations.sol_number=${r.sol_number}`),
  };
  return {
    sol,
    fscName,
    hasOpenPage: typeof r.fsc === 'string' && /^[0-9]{4}$/.test(r.fsc) && r.fsc_depth !== 'excluded',
    awards: awardRows.map((a) => ({
      awardedOn: isoDateNsn(a.awarded_on),
      cage: a.cage,
      supplierName: a.supplier_name,
      unitPrice: Number(a.unit_price),
      quantity: a.quantity !== null ? Number(a.quantity) : null,
    })),
  };
}

// Old supplier search (api/suppliers.json.ts before the change): two sequential queries on the fallback path.
const OLD_BY_CAGE = `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.cage = $1
  GROUP BY s.cage, s.name, s.city, s.state
  LIMIT 8`;
const OLD_BY_NAME = `
  SELECT s.cage, s.name, s.city, s.state, count(*)::int AS awards
  FROM pub.suppliers s
  JOIN pub.price_points pp ON pp.cage = s.cage
  WHERE s.name ILIKE $1 ESCAPE '\\'
  GROUP BY s.cage, s.name, s.city, s.state
  ORDER BY awards DESC, s.name, s.cage
  LIMIT 8`;
async function oldSearchSupplierRows(sql, query) {
  let rows = query.kind === 'cage' ? await sql.unsafe(OLD_BY_CAGE, [query.cage]) : await sql.unsafe(OLD_BY_NAME, [query.pattern]);
  if (query.kind === 'cage' && rows.length === 0 && query.nameFallback) rows = await sql.unsafe(OLD_BY_NAME, [query.nameFallback]);
  return rows;
}

// ------------------------------------------------------- counting TCP proxy
const counts = { parse: 0, query: 0, sync: 0, bind: 0, connections: 0, statements: [] };
const resetCounts = () => {
  counts.parse = counts.query = counts.sync = counts.bind = counts.connections = 0;
  counts.statements = [];
};

function startProxy(upstreamUrl) {
  const u = new URL(upstreamUrl);
  const upHost = u.hostname;
  const upPort = Number(u.port || 5432);
  const server = net.createServer((client) => {
    counts.connections++;
    const up = net.connect(upPort, upHost);
    let buf = Buffer.alloc(0);
    let started = false; // the startup packet has no type byte
    client.on('data', (chunk) => {
      up.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4) break;
          const len = buf.readInt32BE(0);
          if (buf.length < len) break;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code !== 80877103) started = true; // 80877103 = SSLRequest, startup follows
          continue;
        }
        if (buf.length < 5) break;
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) break;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, 1 + len);
        if (type === 'P') {
          counts.parse++;
          const nameEnd = body.indexOf(0);
          const textEnd = body.indexOf(0, nameEnd + 1);
          counts.statements.push(body.subarray(nameEnd + 1, textEnd).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 70));
        } else if (type === 'Q') {
          counts.query++;
          counts.statements.push(body.subarray(0, body.indexOf(0)).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 70));
        } else if (type === 'S') counts.sync++;
        else if (type === 'B') counts.bind++;
        buf = buf.subarray(1 + len);
      }
    });
    up.on('data', (d) => client.write(d));
    const bye = () => {
      client.destroy();
      up.destroy();
    };
    client.on('error', bye);
    up.on('error', bye);
    client.on('close', bye);
    up.on('close', bye);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ------------------------------------------------------------------- runner
const results = { checks: 0, failures: [] };
const groups = {};
const group = (name) => (groups[name] ??= { calls: 0, equal: 0, tieOnly: 0, oneQuery: 0, oldQueries: 0, newQueries: 0, maxOld: 0 });

// The old NSN queries sorted price points by awarded_on, contract actions by action_date and part numbers by
// part_number WITHOUT a tiebreaker, so rows with equal sort keys came back in whatever order the plan produced.
// The new statement breaks those ties by id, which is a legal outcome of the old query. If (and only if) the
// two results differ only in the order inside such equal-key runs, it is reported as "tie-order only", not as a
// failure: the old result is stably re-sorted on (key, id) and must then equal the new one exactly.
function tieOnly(oldV, newV) {
  if (!oldV || !newV || !Array.isArray(oldV.pricePoints)) return false;
  const by = (arr, ...keys) =>
    [...arr].sort((a, b) => {
      for (const k of keys) {
        const x = a[k] ?? null;
        const y = b[k] ?? null;
        if (x === y) continue;
        if (x === null) return 1; // NULLS LAST, as Postgres sorts ascending
        if (y === null) return -1;
        return x < y ? -1 : 1;
      }
      return 0;
    });
  const canon = {
    ...oldV,
    pricePoints: by(oldV.pricePoints, 'awardedOn', 'id'),
    contractActions: by(oldV.contractActions, 'actionDate', 'id'),
    partNumbers: by(oldV.partNumbers, 'partNumber', 'cage'),
  };
  // Agencies are first-seen order over the price points, so rebuild them from the re-sorted list.
  const seen = new Map();
  for (const p of canon.pricePoints) {
    if (p.agencyId === null || seen.has(p.agencyId)) continue;
    seen.set(p.agencyId, oldV.agencies.find((a) => a.agencyId === p.agencyId));
  }
  canon.agencies = [...seen.values()];
  try {
    assert.deepStrictEqual(newV, canon);
    return JSON.stringify(newV) === JSON.stringify(canon);
  } catch {
    return false;
  }
}
const fail = (g, id, msg) => results.failures.push(`[${g}] ${id}: ${msg}`);

let proxyUrl;
/** One request's worth of DB work, as the pages do it: open, load, close. */
async function measured(loader) {
  resetCounts();
  const sql = N.openSql(proxyUrl);
  let debugCalls = 0;
  sql.options.debug = () => debugCalls++;
  try {
    const value = await loader(sql);
    return { value, parse: counts.parse, query: counts.query, sync: counts.sync, debugCalls, statements: [...counts.statements], opts: sql.options };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function compare(name, id, oldFn, newFn, { expectQueries = 1 } = {}) {
  const g = group(name);
  g.calls++;
  const o = await measured(oldFn);
  const n = await measured(newFn);
  g.oldQueries += o.parse + o.query;
  g.newQueries += n.parse + n.query;
  g.maxOld = Math.max(g.maxOld, o.parse + o.query);
  results.checks += 2;
  try {
    assert.deepStrictEqual(n.value, o.value);
    if (JSON.stringify(n.value) !== JSON.stringify(o.value)) throw new Error('JSON text differs (key order)');
    g.equal++;
  } catch (e) {
    if (tieOnly(o.value, n.value)) g.tieOnly++;
    else fail(name, id, `new != old\n${String(e.message).split('\n').slice(0, 25).join('\n')}`);
  }
  const statements = n.parse + n.query;
  if (statements === expectQueries && n.sync === expectQueries && n.debugCalls === expectQueries) g.oneQuery++;
  else fail(name, id, `expected ${expectQueries} round-trip(s), saw parse=${n.parse} query=${n.query} sync=${n.sync} debug=${n.debugCalls}: ${n.statements.join(' | ')}`);
  if (n.opts.fetch_types !== false || n.opts.prepare !== false || n.opts.max !== 1) fail(name, id, 'openSql() options changed (need fetch_types:false, prepare:false, max:1)');
  return { old: o, new: n };
}

// ----------------------------------------------------------------- sampling
async function main() {
  let dbUrl = baseUrl;
  let cloneName = null;
  const adminUrl = withDb(baseUrl, 'postgres');
  if (withSeed) {
    cloneName = new URL(baseUrl).pathname.slice(1) + '_sqverify';
    psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${cloneName}`, '-c', `CREATE DATABASE ${cloneName} TEMPLATE ${new URL(baseUrl).pathname.slice(1)}`]);
    dbUrl = withDb(baseUrl, cloneName);
    psql(dbUrl, ['-f', path.join(here, 'verify-single-query-seed.sql')]);
    if (opt('--tz')) psql(adminUrl, ['-c', `ALTER DATABASE ${cloneName} SET timezone = '${opt('--tz').replace(/'/g, '')}'`]);
    console.log(`seeded clone ${cloneName}`);
  }
  const { server, port } = await startProxy(dbUrl);
  const u = new URL(dbUrl);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  proxyUrl = u.toString();

  const direct = N.openSql(dbUrl);
  const col = async (q) => (await direct.unsafe(q)).map((r) => Object.values(r)[0].trim());
  try {
    const ver = (await direct.unsafe('select version() v'))[0].v;
    console.log(`database: ${new URL(dbUrl).pathname.slice(1)}  (${ver.split(',')[0]})`);

    // ---- NSNs: stratified, deterministic (md5 order), topped up to 320 existing + 5 missing
    const pick = async (label, where, limit) => ({
      label,
      rows: await col(`select n.nsn from pub.nsns n where ${where} order by md5(n.nsn) limit ${limit}`),
    });
    const strata = [
      await pick('with price points', 'exists (select 1 from pub.price_points p where p.nsn = n.nsn)', 90),
      await pick('3+ price points', '(select count(*) from pub.price_points p where p.nsn = n.nsn) >= 3', 25),
      await pick('with contract actions', "exists (select 1 from pub.contract_actions c where c.raw->>'nsn' = n.nsn)", 45),
      await pick('with part numbers', 'exists (select 1 from pub.part_numbers p where p.nsn = n.nsn)', 60),
      await pick('with solicitations', 'exists (select 1 from pub.solicitations s where s.nsn = n.nsn)', 60),
      await pick('3+ solicitations', '(select count(*) from pub.solicitations s where s.nsn = n.nsn) >= 3', 15),
      await pick('with amsc, no pp/ca/pn/sol', "exists (select 1 from pub.amsc_observations a where a.nsn = n.nsn) and not exists (select 1 from pub.price_points p where p.nsn = n.nsn) and not exists (select 1 from pub.solicitations s where s.nsn = n.nsn) and not exists (select 1 from pub.part_numbers p where p.nsn = n.nsn)", 20),
      await pick('bare (no children at all)', "not exists (select 1 from pub.price_points p where p.nsn = n.nsn) and not exists (select 1 from pub.solicitations s where s.nsn = n.nsn) and not exists (select 1 from pub.part_numbers p where p.nsn = n.nsn) and not exists (select 1 from pub.amsc_observations a where a.nsn = n.nsn) and not exists (select 1 from pub.contract_actions c where c.raw->>'nsn' = n.nsn)", 25),
      await pick('seed-only FSCs (7310-7340)', "n.fsc in ('7310','7320','7330','7340')", 40),
      await pick('excluded FSC', "n.fsc in (select fsc from pub.fsc where render_depth = 'excluded')", 10),
      await pick('null characteristics / hazmat / item', 'n.characteristics is null or n.hazmat is null or n.item_name is null', 15),
    ];
    const nsnSet = new Set();
    for (const s of strata) s.rows.forEach((n) => nsnSet.add(n));
    for (const n of await col(`select nsn from pub.nsns order by md5(nsn) limit 400`)) {
      if (nsnSet.size >= 320) break;
      nsnSet.add(n);
    }
    const nsnSample = [...nsnSet];
    const missingNsns = ['9999999999991', '1111111111111', '5340999999999', '0000000000000', '7310000000000'];
    const missingChecked = [];
    for (const m of missingNsns) if ((await col(`select nsn from pub.nsns where nsn = '${m}'`)).length === 0) missingChecked.push(m);
    console.log(`NSN sample: ${nsnSample.length} existing + ${missingChecked.length} missing`);
    for (const s of strata) console.log(`   stratum "${s.label}": ${s.rows.length}`);

    for (const nsn of nsnSample) await compare('loadNsnPage', nsn, (s) => oldLoadNsnPage(s, nsn), (s) => N.loadNsnPage(s, nsn));
    for (const nsn of missingChecked) {
      const r = await compare('loadNsnPage (missing)', nsn, (s) => oldLoadNsnPage(s, nsn), (s) => N.loadNsnPage(s, nsn));
      if (r.new.value !== null) fail('loadNsnPage (missing)', nsn, 'expected null');
    }
    // Malformed input must answer null without touching the database (0 queries, same as before).
    for (const bad of ['123', '534000000000a', '']) {
      const r = await compare('loadNsnPage (malformed)', JSON.stringify(bad), (s) => oldLoadNsnPage(s, bad), (s) => N.loadNsnPage(s, bad), { expectQueries: 0 });
      if (r.new.value !== null) fail('loadNsnPage (malformed)', bad, 'expected null');
    }

    // ---- suppliers
    const supStrata = [
      { label: 'with awards', rows: await col(`select s.cage from pub.suppliers s where exists (select 1 from pub.price_points p where p.cage = s.cage) order by md5(s.cage) limit 55`) },
      { label: 'no awards', rows: await col(`select s.cage from pub.suppliers s where not exists (select 1 from pub.price_points p where p.cage = s.cage) order by md5(s.cage) limit 20`) },
      { label: 'makes parts (part_numbers.cage)', rows: await col(`select s.cage from pub.suppliers s where exists (select 1 from pub.part_numbers p where p.cage = s.cage) order by md5(s.cage) limit 20`) },
      { label: 'in part_numbers only, not a supplier', rows: await col(`select distinct p.cage from pub.part_numbers p where p.cage is not null and not exists (select 1 from pub.suppliers s where s.cage = p.cage) order by 1 limit 10`) },
      { label: 'most awards (200-row cap)', rows: await col(`select cage from pub.price_points where cage is not null group by cage order by count(*) desc, cage limit 3`) },
      { label: 'blank/null name or city', rows: await col(`select cage from pub.suppliers where name is null or btrim(name) = '' or city is null or btrim(city) = '' order by md5(cage) limit 10`) },
    ];
    const supSet = new Set();
    for (const s of supStrata) s.rows.forEach((c) => supSet.add(c));
    for (const c of await col(`select cage from pub.suppliers order by md5(cage)`)) {
      if (supSet.size >= 100) break;
      supSet.add(c);
    }
    const supSample = [...supSet];
    const supMissing = ['ZZZZ1', 'Y9Y9Y', 'A0000', 'QQQQ9', '00000', 'M1SS1', 'NONE1', 'ZZ999', 'Q1W2E', 'ABCDE'];
    const supMissingChecked = [];
    for (const m of supMissing) if ((await col(`select cage from pub.price_points where cage = '${m}'`)).length === 0) supMissingChecked.push(m);
    console.log(`Supplier sample: ${supSample.length} existing + ${supMissingChecked.length} missing`);
    for (const s of supStrata) console.log(`   stratum "${s.label}": ${s.rows.length}`);
    for (const c of supSample) await compare('loadSupplierPage', c, (s) => oldLoadSupplierPage(s, c), (s) => N.loadSupplierPage(s, c));
    let sawNull = 0;
    for (const c of supMissingChecked) {
      const r = await compare('loadSupplierPage (missing)', c, (s) => oldLoadSupplierPage(s, c), (s) => N.loadSupplierPage(s, c));
      if (r.new.value !== null) fail('loadSupplierPage (missing)', c, 'expected null');
      else sawNull++;
    }
    for (const bad of ['abc', 'zzzzz', 'TOOLONG1']) {
      const r = await compare('loadSupplierPage (malformed)', bad, (s) => oldLoadSupplierPage(s, bad), (s) => N.loadSupplierPage(s, bad), { expectQueries: 0 });
      if (r.new.value !== null) fail('loadSupplierPage (malformed)', bad, 'expected null');
    }

    // ---- solicitations
    const solStrata = [
      { label: 'open, future return_by', rows: await col(`select sol_number from pub.solicitations where status='open' and return_by >= current_date order by md5(sol_number) limit 20`) },
      { label: 'open, past return_by (-> expired)', rows: await col(`select sol_number from pub.solicitations where status='open' and return_by < current_date order by md5(sol_number) limit 15`) },
      { label: 'open, no return_by', rows: await col(`select sol_number from pub.solicitations where status='open' and return_by is null order by md5(sol_number) limit 6`) },
      { label: 'expired', rows: await col(`select sol_number from pub.solicitations where status='expired' order by md5(sol_number) limit 12`) },
      { label: 'awarded', rows: await col(`select sol_number from pub.solicitations where status='awarded' order by md5(sol_number) limit 12`) },
      { label: 'cancelled / unknown', rows: await col(`select sol_number from pub.solicitations where status in ('cancelled','unknown') order by md5(sol_number) limit 8`) },
      { label: 'cited by price points', rows: await col(`select distinct sol_number from pub.price_points where sol_number is not null order by 1 limit 25`) },
      { label: 'most awards (100-row cap)', rows: await col(`select sol_number from pub.price_points where sol_number is not null group by 1 order by count(*) desc, 1 limit 2`) },
      { label: 'no NSN / no FSC', rows: await col(`select sol_number from pub.solicitations where nsn is null or fsc is null order by md5(sol_number) limit 8`) },
      { label: 'placeholder / blank / excluded / unknown FSC', rows: await col(`select s.sol_number from pub.solicitations s left join pub.fsc f on f.fsc = s.fsc where f.fsc is null or f.render_depth = 'excluded' or f.name like 'FSC %' or btrim(f.name) = '' order by md5(s.sol_number) limit 12`) },
      { label: 'sam_gov source', rows: await col(`select sol_number from pub.solicitations where source='sam_gov' order by md5(sol_number) limit 6`) },
      { label: 'tied dates on one NSN', rows: await col(`select sol_number from pub.solicitations where sol_number like 'SEED-TIE-%' order by 1`) },
    ];
    const solSet = new Set();
    for (const s of solStrata) s.rows.forEach((c) => solSet.add(c));
    for (const c of await col(`select sol_number from pub.solicitations order by md5(sol_number) limit 300`)) {
      if (solSet.size >= 100) break;
      solSet.add(c);
    }
    const solSample = [...solSet];
    const solMissing = ['NOPE-0001', 'SPE-0000000000', 'ZZZ', 'H-0000000000000-9', 'seed-0001', 'SEED-9999', 'X1', 'NONE-NONE', 'UNC99999999', 'SEED-0'];
    const solMissingChecked = [];
    for (const m of solMissing) if ((await col(`select sol_number from pub.solicitations where sol_number = '${m}'`)).length === 0) solMissingChecked.push(m);
    console.log(`Solicitation sample: ${solSample.length} existing + ${solMissingChecked.length} missing`);
    for (const s of solStrata) console.log(`   stratum "${s.label}": ${s.rows.length}`);
    for (const c of solSample) await compare('loadSolicitationPage', c, (s) => oldLoadSolicitationPage(s, c), (s) => N.loadSolicitationPage(s, c));
    for (const c of solMissingChecked) {
      const r = await compare('loadSolicitationPage (missing)', c, (s) => oldLoadSolicitationPage(s, c), (s) => N.loadSolicitationPage(s, c));
      if (r.new.value !== null) fail('loadSolicitationPage (missing)', c, 'expected null');
    }
    for (const bad of ['has space', 'a/b', '']) {
      const r = await compare('loadSolicitationPage (malformed)', JSON.stringify(bad), (s) => oldLoadSolicitationPage(s, bad), (s) => N.loadSolicitationPage(s, bad), { expectQueries: 0 });
      if (r.new.value !== null) fail('loadSolicitationPage (malformed)', bad, 'expected null');
    }

    // ---- supplier search (/api/suppliers.json): same rows, one statement even on the CAGE-then-name fallback
    const searches = [];
    for (const c of supSample.slice(0, 15)) searches.push(c); // exact CAGE (digits: no fallback when it has a digit)
    for (const q of ['ACME', 'SEED SUPPLY 1', 'seal', 'bolt', 'precision', 'TITAN', 'zzzz', 'Town', 'ABCDE', 'FASTE', 'SEALS', 'BOLTS', 'SUPPLY', 'LLC', 'INC', 'NUT', 'METAL', 'PARTS', 'NOSUCH', 'ACMEX']) searches.push(q);
    for (const q of searches) {
      const query = N.parseSupplierQuery(q);
      if (query.kind === 'none') continue;
      await compare('searchSupplierRows', q, (s) => oldSearchSupplierRows(s, query).then((rows) => rows.map((x) => ({ ...x }))), (s) => N.searchSupplierRows(s, query).then((rows) => rows.map((x) => ({ ...x }))), {
        expectQueries: 1,
      });
      // The old path legitimately costs 2 queries on the fallback; only the new one is asserted == 1.
    }
  } finally {
    await direct.end({ timeout: 1 }).catch(() => {});
    server.close();
    if (cloneName && !keep) {
      try {
        psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${cloneName}`]);
      } catch (e) {
        console.log(`(could not drop ${cloneName}: ${e.message})`);
      }
    } else if (cloneName) console.log(`kept clone ${cloneName}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- summary
  console.log('\nloader                              calls  identical  tie-order-only  1 round-trip  old stmts (avg/max)  new stmts (avg)');
  for (const [name, g] of Object.entries(groups)) {
    console.log(
      `${name.padEnd(36)}${String(g.calls).padStart(5)}${String(g.equal).padStart(11)}${String(g.tieOnly).padStart(16)}${String(g.oneQuery).padStart(14)}` +
        `${(g.oldQueries / g.calls).toFixed(2).padStart(14)} /${String(g.maxOld).padStart(2)}${(g.newQueries / g.calls).toFixed(2).padStart(17)}`
    );
  }
  console.log(`\n${results.checks} checks, ${results.failures.length} failures`);
  for (const f of results.failures.slice(0, 20)) console.log('FAIL ' + f);
  if (results.failures.length > 20) console.log(`... and ${results.failures.length - 20} more`);
  console.log(results.failures.length === 0 ? 'PASS' : 'FAIL');
  process.exit(results.failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
