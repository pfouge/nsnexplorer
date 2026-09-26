// ingest/sam/map-sam.mjs
// Pure mapper from a SAM.gov Opportunities API v2 opportunity object (see
// ingest/sam/fetch.mjs's opportunitiesData[] entries) to a canonical
// pub.solicitations row. No DB access here — see load.mjs for the write
// path, and map-sam.test.mjs for unit tests against a synthetic fixture.
//
// SAM opportunities almost never carry a structured NSN — this is the
// all-agency contract-notice board, not DIBBS's NSN-keyed RFQ grid — so
// every mapped row has nsn = null. Those rows are still stored in
// pub.solicitations (source='sam_gov'), but they will NOT appear on the
// NSN-keyed catalog/browse pages until a follow-up view is built to list
// null-nsn open solicitations directly (see load.mjs's module header).

/** Extracts just the YYYY-MM-DD date portion from an ISO-ish timestamp. */
function toDateOnly(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** True when `code` looks like a 4-character PSC/FSC-style code (e.g. '5331'). */
function looksLikePsc(code) {
  return typeof code === 'string' && /^[A-Z0-9]{4}$/i.test(code.trim());
}

/**
 * Maps a single SAM opportunitiesData[] entry to a canonical
 * pub.solicitations row, or returns { skip: reason } when the row should
 * be skipped entirely (never written).
 *
 * @param {object} rec - a SAM Opportunities API v2 opportunity object
 * @returns {{ row: object } | { skip: string }}
 */
export function mapSamRecord(rec) {
  const solNumber = String(rec?.solicitationNumber ?? '').trim();
  if (!solNumber) {
    return { skip: 'no-sol' };
  }

  const sourceUrl = String(rec?.uiLink ?? '').trim();
  if (!sourceUrl) {
    return { skip: 'no-url' };
  }

  // SAM's search defaults to active opportunities, so 'open' unless the
  // record explicitly says otherwise.
  const status = String(rec?.active ?? '').trim().toLowerCase() === 'no' ? 'expired' : 'open';

  const classificationCode = rec?.classificationCode
    ? String(rec.classificationCode).trim().toUpperCase()
    : null;
  const fsc = looksLikePsc(classificationCode) ? classificationCode : null;

  const row = {
    sol_number: solNumber,
    nsn: null,
    quantity: null,
    unit_of_issue: null,
    issued_on: toDateOnly(rec?.postedDate),
    return_by: toDateOnly(rec?.responseDeadLine),
    status,
    amc: null,
    amsc: null,
    setaside: rec?.typeOfSetAside ?? null,
    buyer_office: rec?.fullParentPathName || rec?.organizationType || null,
    source: 'sam_gov',
    nomenclature: rec?.title ?? null,
    fsc,
    source_url: sourceUrl,
    raw: rec,
  };

  return { row };
}
