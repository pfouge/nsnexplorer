#!/usr/bin/env node
// scoring/score.mjs
// Implements docs/scoring-model-v1.md exactly: two tracks (Challenger,
// per-NSN; Quoter, per-open-solicitation), hard filters, weights, and
// clamps as specified. Reads pub.*, writes ops.targets. Never imported by
// /web (see docs/architecture.md #6).
//
// ops.targets has ONE ROW PER NSN (its primary key is `nsn`), but the
// Quoter score is defined per open solicitation. Where an NSN has more
// than one open solicitation, this scores each and keeps the
// highest-scoring one as the NSN's representative Quoter row; the losing
// solicitation numbers are still visible in score_components for audit.
//
// DATA GAPS (documented, not silently guessed): the model calls for a
// "material+machining proxy for the FSC" (G), a categorical drawings-path
// determination (D), and a supplier cost basis (P, M) that this project
// does not yet ingest in bulk (FLIS/characteristics ingestion is Phase 1b
// per docs/architecture.md; supplier quotes are hand-entered into
// ops.quotes). Where real data is missing this file uses small, clearly
// labeled starting-prior tables/heuristics and computes from ops.quotes
// when present, consistent with the doc's framing of weights/priors as
// "starting priors — recalibrate after the first 50 hand quotes."
//
// CLI:
//   node score.mjs                 # scores both tracks
//   node score.mjs --track challenger
//   node score.mjs --track quoter

import { getPool, closePool } from '../shared/db.mjs';

export const SCORING_VERSION = 'v1.0';

/** statement_timeout for this script's own connection (see main). */
const STATEMENT_TIMEOUT = '900s';

export const WEIGHTS_CHALLENGER = { V: 0.3, G: 0.25, S: 0.15, D: 0.15, A: 0.15 };
export const WEIGHTS_QUOTER = { P: 0.35, C: 0.25, M: 0.2, F: 0.2 };

const QUOTER_AMSC_CODES = ['G', 'Z', 'T'];
const RESTRICTIVE_AMSC_CODES = ['B', 'C', 'D', 'P', 'R'];
const AMSC_A_VALUE = { B: 0.8, C: 1.0, D: 1.0, P: 1.0, R: 1.0, H: 0.6 };

// S — mechanical simplicity FSC priors (docs table, verbatim).
const SIMPLICITY_FSC_PRIOR = {
  '5331': 0.9, // O-rings
  '5330': 0.85, // Packing and gasket materials
  '5306': 0.85, // Bolts
  '5305': 0.85, // Screws
  '5365': 0.8, // Spacers/rings
};
const SIMPLICITY_MACHINED_DEFAULT = 0.5; // "machined-part classes 0.40-0.60" midpoint prior
const SIMPLICITY_ASSEMBLY_CAP = 0.25;

const EXOTIC_MATERIAL_KEYWORDS = ['inconel', 'titanium', 'waspaloy', 'monel'];
const CRITICALITY_KEYWORDS = ['flight safety', 'flight-critical', 'flight critical', 'critical application'];
const ASSEMBLY_KEYWORDS = ['assembly', 'assy'];

// Hard-filter controlled-category keywords (item name / characteristics).
const CONTROLLED_KEYWORDS = [
  'guidance',
  'crypto',
  'cryptographic',
  'night vision',
  'night-vision',
  'nuclear',
  'classified',
];

// G — price floor proxy per FSC (material+machining cost prior, dollars).
// DATA GAP: no manufacturing-cost ingestion exists yet; these are
// placeholder starting priors per the doc's recalibration protocol.
const FSC_FLOOR_PROXY = {
  '5331': 2,
  '5330': 3,
  '5306': 1,
  '5305': 1,
};
const FSC_FLOOR_PROXY_DEFAULT = 5;

export function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function lerp(x, x0, x1, y0, y1) {
  return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
}

/**
 * F — size fit. 1.0 for $2.5k-$25k, taper to 0.3 above $100k, taper to 0.5
 * below $1k (held flat outside the tapering bands).
 */
export function sizeFitScore(totalValue) {
  const v = Number(totalValue);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v < 1000) return 0.5;
  if (v < 2500) return lerp(v, 1000, 2500, 0.5, 1.0);
  if (v <= 25000) return 1.0;
  if (v < 100000) return lerp(v, 25000, 100000, 1.0, 0.3);
  return 0.3;
}

/**
 * S — mechanical simplicity: FSC prior, capped for assemblies, minus 0.2
 * per exotic-material keyword hit, minus 0.3 if criticality/flight-safety
 * coded. Clamped to [0,1].
 */
export function simplicityScore(fsc, itemName, characteristics) {
  let base = SIMPLICITY_FSC_PRIOR[fsc] ?? SIMPLICITY_MACHINED_DEFAULT;

  const text = `${itemName || ''} ${JSON.stringify(characteristics || {})}`.toLowerCase();

  if (ASSEMBLY_KEYWORDS.some((k) => text.includes(k))) {
    base = Math.min(base, SIMPLICITY_ASSEMBLY_CAP);
  }

  let penalty = 0;
  for (const kw of EXOTIC_MATERIAL_KEYWORDS) {
    if (text.includes(kw)) penalty += 0.2;
  }
  if (CRITICALITY_KEYWORDS.some((k) => text.includes(k))) penalty += 0.3;

  return clamp01(base - penalty);
}

/**
 * D — drawings path. DATA GAP: no RPPOB/reverse-engineering-assessment
 * ingestion exists yet, so this proxies on how much structured
 * `characteristics` data is on file: richer characteristics -> more
 * plausible a drawing package could be reconstructed without OEM data.
 * Categorical values (0.9/0.6/0.3/0.1) match the doc's four buckets.
 */
export function drawingsPathScore(characteristics, itemName) {
  const keyCount = characteristics && typeof characteristics === 'object'
    ? Object.keys(characteristics).length
    : 0;
  if (keyCount >= 5) return 0.9;
  if (keyCount >= 1) return 0.6;
  if (itemName) return 0.3;
  return 0.1;
}

// Per-NSN statements. The SQL of each is written ONCE (as a fragment over an NSN expression) and used
// twice: with $1 for one NSN, and with n.nsn inside a LATERAL / correlated subquery over unnest() for many
// NSNs in one statement (the prefetch below). Same SQL per NSN, so the same rows, the same index scan and
// the same row on an ORDER BY ... LIMIT 1 tie.
const VOLUME_SUM_SQL = (nsn) => `SELECT COALESCE(SUM(COALESCE(total_value, unit_price * COALESCE(quantity, 1))), 0) AS sum_value
     FROM pub.price_points
     WHERE nsn = ${nsn} AND awarded_on >= (CURRENT_DATE - INTERVAL '3 years')`;
const LATEST_PRICE_SQL = (nsn) => `SELECT unit_price FROM pub.price_points WHERE nsn = ${nsn} ORDER BY awarded_on DESC LIMIT 1`;
const P25_SQL = (nsn) => `SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY unit_price) AS p25
     FROM pub.price_points WHERE nsn = ${nsn}`;
const LATEST_AMSC_SQL = (nsn) => `SELECT amsc, amc, observed_on FROM pub.amsc_observations
     WHERE nsn = ${nsn} ORDER BY observed_on DESC LIMIT 1`;
const DISTINCT_CAGES_SQL = (nsn) => `SELECT COUNT(DISTINCT cage) AS n FROM pub.price_points
     WHERE nsn = ${nsn} AND cage IS NOT NULL AND awarded_on >= (CURRENT_DATE - INTERVAL '5 years')`;
const UNAWARDED_SQL = (nsn) => `SELECT COUNT(*) AS n FROM pub.solicitations
     WHERE nsn = ${nsn} AND status IN ('cancelled', 'expired')
       AND issued_on >= (CURRENT_DATE - INTERVAL '2 years')`;
const EXACT_QUOTE_SQL = (sol) => `SELECT supplier_cost, our_unit_price, created_at FROM ops.quotes
     WHERE sol_number = ${sol} AND supplier_cost IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`;
const NSN_QUOTE_SQL = (nsn) => `SELECT supplier_cost FROM ops.quotes
       WHERE nsn = ${nsn} AND supplier_cost IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`;

/** Trailing-3-year mean annual spend from the summed value (numeric text). */
const annualSpendFrom = (sumValue) => Number(sumValue) / 3;

/** Price-gap figures from the latest unit price (null when the NSN has no price points) and the p25. */
function priceGapFrom(latestUnitPrice, p25Value, fsc) {
  if (latestUnitPrice === null || latestUnitPrice === undefined) return null;
  const latest = Number(latestUnitPrice);
  const p25 = p25Value !== null ? Number(p25Value) : 0;
  const proxy = FSC_FLOOR_PROXY[fsc] ?? FSC_FLOOR_PROXY_DEFAULT;
  const floor = Math.max(p25, proxy);
  if (floor <= 0) return { latest, floor, ratio: null };
  return { latest, floor, ratio: latest / floor };
}

async function volumeStats(client, nsn) {
  const res = await client.query(VOLUME_SUM_SQL('$1'), [nsn]);
  return annualSpendFrom(res.rows[0].sum_value);
}

async function priceGapStats(client, nsn, fsc) {
  const latestRes = await client.query(LATEST_PRICE_SQL('$1'), [nsn]);
  if (latestRes.rowCount === 0) return null;
  const p25Res = await client.query(P25_SQL('$1'), [nsn]);
  return priceGapFrom(latestRes.rows[0].unit_price, p25Res.rows[0].p25, fsc);
}

async function latestAmsc(client, nsn) {
  const res = await client.query(LATEST_AMSC_SQL('$1'), [nsn]);
  return res.rowCount ? res.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Prefetch: the same per-NSN statements for MANY NSNs in one statement each. Scoring ~180k NSNs one
// statement at a time was ~540k round trips (11 minutes on a quiet day, 3.5 hours on 2026-11-15 while the
// database was busy, when one statement passed the role's 120 s timeout). Results are Maps keyed by NSN.

/** Summed 3-year value per NSN, for the NSNs given (an NSN with no rows gets '0', as VOLUME_SUM_SQL does). */
async function volumeStatsMany(client, nsns) {
  const out = new Map();
  if (nsns.length === 0) return out;
  const res = await client.query(
    `SELECT n.nsn, (${VOLUME_SUM_SQL('n.nsn')}) AS sum_value FROM unnest($1::bpchar[]) AS n(nsn)`,
    [nsns]
  );
  for (const r of res.rows) out.set(r.nsn, r.sum_value);
  return out;
}

/** Latest AMSC observation per NSN (NSNs without one are absent). */
async function latestAmscMany(client, nsns) {
  const out = new Map();
  if (nsns.length === 0) return out;
  const res = await client.query(
    `SELECT n.nsn, a.amsc, a.amc, a.observed_on
     FROM unnest($1::bpchar[]) AS n(nsn)
     CROSS JOIN LATERAL (${LATEST_AMSC_SQL('n.nsn')}) a`,
    [nsns]
  );
  for (const r of res.rows) out.set(r.nsn, { amsc: r.amsc, amc: r.amc, observed_on: r.observed_on });
  return out;
}

/** Latest unit price (null when none) and p25 per NSN. */
async function priceFiguresMany(client, nsns) {
  const out = new Map();
  if (nsns.length === 0) return out;
  const res = await client.query(
    `SELECT n.nsn, (${LATEST_PRICE_SQL('n.nsn')}) AS unit_price, (${P25_SQL('n.nsn')}) AS p25
     FROM unnest($1::bpchar[]) AS n(nsn)`,
    [nsns]
  );
  for (const r of res.rows) out.set(r.nsn, { unitPrice: r.unit_price, p25: r.p25 });
  return out;
}

/** Quoter per-NSN figures: last award price (null when none), distinct CAGEs (5 years), unawarded count, NSN quote. */
async function quoterNsnFiguresMany(client, nsns) {
  const out = new Map();
  if (nsns.length === 0) return out;
  const res = await client.query(
    `SELECT n.nsn,
            (${LATEST_PRICE_SQL('n.nsn')}) AS unit_price,
            (${DISTINCT_CAGES_SQL('n.nsn')}) AS cages,
            (${UNAWARDED_SQL('n.nsn')}) AS unawarded,
            q.supplier_cost AS nsn_quote_cost, (q.supplier_cost IS NOT NULL) AS has_nsn_quote
     FROM unnest($1::bpchar[]) AS n(nsn)
     LEFT JOIN LATERAL (${NSN_QUOTE_SQL('n.nsn')}) q ON true`,
    [nsns]
  );
  for (const r of res.rows) {
    out.set(r.nsn, { unitPrice: r.unit_price, cages: r.cages, unawarded: r.unawarded, nsnQuote: r.has_nsn_quote ? { supplier_cost: r.nsn_quote_cost } : null });
  }
  return out;
}

/** Latest quote with a supplier cost per solicitation number (solicitations without one are absent). */
async function exactQuotesMany(client, solNumbers) {
  const out = new Map();
  if (solNumbers.length === 0) return out;
  const res = await client.query(
    `SELECT s.sol_number, q.supplier_cost, q.our_unit_price, q.created_at
     FROM unnest($1::text[]) AS s(sol_number)
     CROSS JOIN LATERAL (${EXACT_QUOTE_SQL('s.sol_number')}) q`,
    [solNumbers]
  );
  for (const r of res.rows) out.set(r.sol_number, { supplier_cost: r.supplier_cost, our_unit_price: r.our_unit_price, created_at: r.created_at });
  return out;
}

async function upsertTarget(client, { nsn, track, score, components, status }) {
  const scoredAt = new Date();
  if (status) {
    await client.query(
      `INSERT INTO ops.targets (nsn, track, score, score_components, scored_at, scoring_version, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (nsn) DO UPDATE SET
         track = EXCLUDED.track,
         score = EXCLUDED.score,
         score_components = EXCLUDED.score_components,
         scored_at = EXCLUDED.scored_at,
         scoring_version = EXCLUDED.scoring_version,
         status = EXCLUDED.status`,
      [nsn, track, score, JSON.stringify(components), scoredAt, SCORING_VERSION, status]
    );
  } else {
    await client.query(
      `INSERT INTO ops.targets (nsn, track, score, score_components, scored_at, scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (nsn) DO UPDATE SET
         track = EXCLUDED.track,
         score = EXCLUDED.score,
         score_components = EXCLUDED.score_components,
         scored_at = EXCLUDED.scored_at,
         scoring_version = EXCLUDED.scoring_version`,
      [nsn, track, score, JSON.stringify(components), scoredAt, SCORING_VERSION]
    );
  }
}

/**
 * Scores a single NSN on the Challenger track. Returns a result object
 * describing what happened: { filtered, skipped, scored, reason?, score?,
 * components? } — never throws for expected "not enough data" cases.
 */
/** The Challenger hard filters that need no database read: a reason string, or null when the NSN passes. */
function challengerHardFilter(nsnRow) {
  const { item_name: itemName, characteristics, hazmat, render_depth: renderDepth } = nsnRow;
  if (renderDepth === 'excluded') return 'FSC excluded (render_depth=excluded)';
  if (hazmat === true) return 'hazmat=true';
  const text = `${itemName || ''} ${JSON.stringify(characteristics || {})}`.toLowerCase();
  const controlledHit = CONTROLLED_KEYWORDS.find((k) => text.includes(k));
  if (controlledHit) return `controlled category keyword: ${controlledHit}`;
  return null;
}

const CHALLENGER_MIN_ANNUAL_SPEND = 25000;

/**
 * Scores a single NSN on the Challenger track. `pre` (optional) holds the prefetched per-NSN figures
 * from scoreChallengers ({ volume, amsc, prices } Maps); without it each figure is read on its own.
 */
export async function scoreChallengerNsn(client, nsnRow, pre = null) {
  const { nsn, fsc, item_name: itemName, characteristics } = nsnRow;

  const hardFilter = challengerHardFilter(nsnRow);
  if (hardFilter) {
    return { filtered: true, reason: hardFilter };
  }

  const annualSpend = pre ? annualSpendFrom(pre.volume.get(nsn) ?? '0') : await volumeStats(client, nsn);
  if (annualSpend < CHALLENGER_MIN_ANNUAL_SPEND) {
    return { filtered: true, reason: `annual volume $${annualSpend.toFixed(0)} < $25k threshold` };
  }

  const amscObs = pre ? (pre.amsc.get(nsn) ?? null) : await latestAmsc(client, nsn);
  if (!amscObs || !amscObs.amsc) {
    return { skipped: true, reason: 'no AMSC observation on record — cannot determine track' };
  }
  if (QUOTER_CODES_INCLUDE(amscObs.amsc)) {
    return { skipped: true, reason: 'AMSC competitive (G/Z/T) — belongs to Quoter track' };
  }

  let gap;
  if (pre) {
    const pf = pre.prices.get(nsn);
    gap = pf ? priceGapFrom(pf.unitPrice, pf.p25, fsc) : null;
  } else {
    gap = await priceGapStats(client, nsn, fsc);
  }
  if (!gap || gap.ratio === null) {
    return { filtered: true, reason: 'no price history for NSN — cannot compute price gap' };
  }

  const V = clamp01((Math.log10(annualSpend) - 4) / 2);
  const G = clamp01((gap.ratio - 1) / 9);
  const S = simplicityScore(fsc, itemName, characteristics);
  let D = drawingsPathScore(characteristics, itemName);
  let A;
  if (RESTRICTIVE_AMSC_CODES.includes(amscObs.amsc)) {
    A = AMSC_A_VALUE[amscObs.amsc];
  } else if (amscObs.amsc === 'H') {
    A = AMSC_A_VALUE.H;
    D = Math.min(D, 0.3); // "AMSC H and others -> reduced drawings-path score"
  } else {
    A = 0.5; // unlisted/other non-competitive code — documented placeholder prior
    D = Math.min(D, 0.3);
  }

  const score = 100 * (
    WEIGHTS_CHALLENGER.V * V +
    WEIGHTS_CHALLENGER.G * G +
    WEIGHTS_CHALLENGER.S * S +
    WEIGHTS_CHALLENGER.D * D +
    WEIGHTS_CHALLENGER.A * A
  );

  const components = {
    track: 'challenger',
    factors: { V, G, S, D, A },
    weights: WEIGHTS_CHALLENGER,
    inputs: {
      annualSpend,
      latestUnitPrice: gap.latest,
      priceFloor: gap.floor,
      priceRatio: gap.ratio,
      amsc: amscObs.amsc,
      amc: amscObs.amc,
      amscObservedOn: amscObs.observed_on,
    },
  };

  await upsertTarget(client, { nsn, track: 'challenger', score, components });
  return { scored: true, score, components };
}

function QUOTER_CODES_INCLUDE(amsc) {
  return QUOTER_AMSC_CODES.includes(amsc);
}

/**
 * Scores a single open solicitation on the Quoter track. Returns
 * { skipped, scored, reason?, score?, components? }.
 */
export async function scoreQuoterSolicitation(client, sol, pre = null) {
  const { sol_number: solNumber, nsn, quantity } = sol;
  if (!nsn) return { skipped: true, reason: 'solicitation has no linked NSN' };

  const amscObs = pre ? (pre.amsc.get(nsn) ?? null) : await latestAmsc(client, nsn);
  if (!amscObs || !QUOTER_CODES_INCLUDE(amscObs.amsc)) {
    return { skipped: true, reason: 'AMSC not competitive (G/Z/T) — belongs to Challenger track' };
  }

  // P — price confidence, sourced from ops.quotes (our hand-entered
  // supplier cost basis; DATA GAP: no bulk supplier-catalog ingestion).
  let exactQuote;
  if (pre) {
    exactQuote = pre.exactQuotes.get(solNumber) ?? null;
  } else {
    const exactQuoteRes = await client.query(EXACT_QUOTE_SQL('$1'), [solNumber]);
    exactQuote = exactQuoteRes.rowCount > 0 ? exactQuoteRes.rows[0] : null;
  }
  const nsnFigures = pre ? pre.nsnFigures.get(nsn) : null;

  let P;
  let supplierCost = null;
  if (exactQuote) {
    supplierCost = Number(exactQuote.supplier_cost);
    const ageDays = (Date.now() - new Date(exactQuote.created_at).getTime()) / 86400000;
    P = ageDays <= 90 ? 1.0 : 0.7;
  } else {
    let nsnQuote;
    if (pre) {
      nsnQuote = nsnFigures?.nsnQuote ?? null;
    } else {
      const nsnQuoteRes = await client.query(NSN_QUOTE_SQL('$1'), [nsn]);
      nsnQuote = nsnQuoteRes.rowCount > 0 ? nsnQuoteRes.rows[0] : null;
    }
    if (nsnQuote) {
      supplierCost = Number(nsnQuote.supplier_cost);
      P = 0.4; // equivalent-spec part priced (same NSN, different solicitation)
    } else {
      P = 0; // no cost basis — auto no-bid
    }
  }

  let lastUnitPrice;
  if (pre) {
    lastUnitPrice = nsnFigures?.unitPrice ?? null;
  } else {
    const lastAwardRes = await client.query(LATEST_PRICE_SQL('$1'), [nsn]);
    lastUnitPrice = lastAwardRes.rowCount ? lastAwardRes.rows[0].unit_price : null;
  }
  const lastAwardPrice = lastUnitPrice !== null ? Number(lastUnitPrice) : null;

  // C — competition sparsity.
  const distinctCages = Number(pre ? nsnFigures.cages : (await client.query(DISTINCT_CAGES_SQL('$1'), [nsn])).rows[0].n);
  let C = 1 - Math.min(distinctCages, 5) / 5;

  const unawarded = Number(pre ? nsnFigures.unawarded : (await client.query(UNAWARDED_SQL('$1'), [nsn])).rows[0].n);
  if (unawarded > 0) C += 0.2;
  C = clamp01(C);

  // M — margin at a bid 10% under the last award price.
  let M = 0;
  if (lastAwardPrice && supplierCost !== null && lastAwardPrice > 0) {
    const bidPrice = lastAwardPrice * 0.9;
    const marginPct = (bidPrice - supplierCost) / bidPrice;
    M = clamp01((marginPct - 0.15) / 0.3);
  }

  // F — size fit.
  const refPrice = lastAwardPrice ?? (exactQuote?.our_unit_price ? Number(exactQuote.our_unit_price) : null);
  let F = 0;
  let totalValue = null;
  if (quantity && refPrice) {
    totalValue = Number(quantity) * refPrice;
    F = sizeFitScore(totalValue);
  }

  const score = 100 * (
    WEIGHTS_QUOTER.P * P +
    WEIGHTS_QUOTER.C * C +
    WEIGHTS_QUOTER.M * M +
    WEIGHTS_QUOTER.F * F
  );

  const components = {
    track: 'quoter',
    solNumber,
    factors: { P, C, M, F },
    weights: WEIGHTS_QUOTER,
    inputs: { supplierCost, lastAwardPrice, distinctCages, totalValue, amsc: amscObs.amsc },
  };

  return { scored: true, score, components, nsn, solNumber };
}

export async function scoreChallengers(client) {
  const res = await client.query(
    `SELECT n.nsn, n.fsc, n.item_name, n.characteristics, n.hazmat, f.render_depth
     FROM pub.nsns n JOIN pub.fsc f ON f.fsc = n.fsc`
  );

  // Prefetch each figure for exactly the NSNs that reach it (the same funnel scoreChallengerNsn walks):
  // volume for those past the hard filters, AMSC for those past the volume floor, prices for those on
  // the Challenger side of the AMSC split. One statement per figure instead of one per NSN.
  const pastFilters = [...new Set(res.rows.filter((r) => challengerHardFilter(r) === null).map((r) => r.nsn))];
  const volume = await volumeStatsMany(client, pastFilters);
  const pastVolume = pastFilters.filter((nsn) => annualSpendFrom(volume.get(nsn) ?? '0') >= CHALLENGER_MIN_ANNUAL_SPEND);
  const amsc = await latestAmscMany(client, pastVolume);
  const challengerSide = pastVolume.filter((nsn) => {
    const a = amsc.get(nsn);
    return a && a.amsc && !QUOTER_CODES_INCLUDE(a.amsc);
  });
  const prices = await priceFiguresMany(client, challengerSide);
  const pre = { volume, amsc, prices };

  const summary = { scored: 0, filtered: [], skipped: [] };
  for (const row of res.rows) {
    const result = await scoreChallengerNsn(client, row, pre);
    if (result.scored) summary.scored += 1;
    else if (result.filtered) summary.filtered.push({ nsn: row.nsn, reason: result.reason });
    else if (result.skipped) summary.skipped.push({ nsn: row.nsn, reason: result.reason });
  }
  return summary;
}

export async function scoreQuoters(client) {
  const res = await client.query(
    `SELECT sol_number, nsn, quantity FROM pub.solicitations WHERE status = 'open' AND nsn IS NOT NULL`
  );

  // Prefetch (see scoreChallengers): AMSC for every NSN with an open solicitation, the per-NSN figures
  // for the NSNs on the Quoter side of the AMSC split, and the latest quote per solicitation number.
  const nsns = [...new Set(res.rows.map((r) => r.nsn).filter(Boolean))];
  const amsc = await latestAmscMany(client, nsns);
  const quoterSide = nsns.filter((nsn) => {
    const a = amsc.get(nsn);
    return a && QUOTER_CODES_INCLUDE(a.amsc);
  });
  const quoterSideSet = new Set(quoterSide);
  const nsnFigures = await quoterNsnFiguresMany(client, quoterSide);
  const exactQuotes = await exactQuotesMany(client, [...new Set(res.rows.filter((r) => quoterSideSet.has(r.nsn)).map((r) => r.sol_number))]);
  const pre = { amsc, nsnFigures, exactQuotes };

  const bestByNsn = new Map(); // nsn -> { score, components }
  const allResults = [];
  const skipped = [];

  for (const sol of res.rows) {
    const result = await scoreQuoterSolicitation(client, sol, pre);
    allResults.push(result);
    if (result.skipped) {
      skipped.push({ solNumber: sol.sol_number, reason: result.reason });
      continue;
    }
    const existing = bestByNsn.get(sol.nsn);
    if (!existing || result.score > existing.score) {
      bestByNsn.set(sol.nsn, result);
    }
  }

  for (const [nsn, result] of bestByNsn) {
    await upsertTarget(client, { nsn, track: 'quoter', score: result.score, components: result.components });
  }

  return { scored: bestByNsn.size, solicitationsConsidered: res.rowCount, skipped };
}

function parseArgs(argv) {
  const args = { track: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--track') args.track = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  const client = await pool.connect();
  try {
    // The prefetch statements read pub.price_points / pub.amsc_observations for every NSN at once; on a
    // busy database (2026-11-15: two failures at the role's 120 s statement_timeout) one of them can run
    // longer than the role default, so this connection sets its own limit (the site build does the same).
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
    if (args.track === 'all' || args.track === 'challenger') {
      const summary = await scoreChallengers(client);
      console.log(
        `score.mjs [challenger]: ${summary.scored} scored, ${summary.filtered.length} filtered, ${summary.skipped.length} skipped`
      );
      for (const f of summary.filtered) console.log(`  filtered ${f.nsn}: ${f.reason}`);
      for (const s of summary.skipped) console.log(`  skipped ${s.nsn}: ${s.reason}`);
    }
    if (args.track === 'all' || args.track === 'quoter') {
      const summary = await scoreQuoters(client);
      console.log(
        `score.mjs [quoter]: ${summary.scored} NSN(s) scored from ${summary.solicitationsConsidered} open solicitation(s), ${summary.skipped.length} solicitations skipped`
      );
      for (const s of summary.skipped) console.log(`  skipped ${s.solNumber}: ${s.reason}`);
    }
  } finally {
    client.release();
    await closePool();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
