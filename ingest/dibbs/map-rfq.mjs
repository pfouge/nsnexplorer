// ingest/dibbs/map-rfq.mjs
// Pure mapper from a parseRfqGrid record (see ingest/dibbs/parse.mjs) to a
// canonical pub.solicitations row. No DB access here — see load.mjs's
// loadRfqSolicitations for the write path, and map-rfq.test.mjs for the
// unit tests against the committed fixture.
//
// We only load NSN-keyed solicitations (breadth-first rendering across the
// entire catalog depends on every open row resolving to a real NSN page);
// the RFQ grid's Nsn cell sometimes carries a non-NSN local identifier
// instead (mirrors the award grid's nsnRaw — see parse.mjs), and those rows
// are skipped rather than guessed at.

/**
 * Strips everything but digits from `raw` and requires the result to be
 * exactly 13 digits (a full NSN — FSC + NIIN). Returns null otherwise.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeNsn13(raw) {
  if (raw === null || raw === undefined) return null;
  const digitsOnly = String(raw).replace(/\D+/g, '');
  return /^\d{13}$/.test(digitsOnly) ? digitsOnly : null;
}

/**
 * Maps a single parseRfqGrid record to a canonical pub.solicitations row, or
 * returns null (with a reason) when the row should be skipped.
 *
 * @param {object} rec - a parseRfqGrid record ({ nsnRaw, nsnQualifier,
 *   nomenclature, techDocs, solicitation, status, purchaseRequest, quantity,
 *   issued, returnBy })
 * @param {{ today: string }} opts - `today` is an ISO 'YYYY-MM-DD' string,
 *   passed in (rather than read from Date.now()) for deterministic tests.
 * @returns {{ row: object, nsn: string, fsc: string, nomenclature: string|null } | { skip: string }}
 */
export function mapRfqRecord(rec, { today }) {
  const nsn = normalizeNsn13(rec.nsnRaw);
  if (!nsn) {
    return { skip: 'non-nsn' };
  }

  const solNumber = (rec.solicitation ?? '').trim();
  if (!solNumber) {
    return { skip: 'no-sol' };
  }

  const fsc = nsn.slice(0, 4);
  const quantity = rec.quantity ?? null;
  const issuedOn = rec.issued || null;
  const returnBy = rec.returnBy || null;
  const nomenclature = rec.nomenclature ?? null;

  let status;
  if (String(rec.status).trim().toLowerCase() === 'removed') {
    status = 'cancelled';
  } else if (returnBy && returnBy < today) {
    status = 'expired';
  } else {
    status = 'open';
  }

  const sourceUrl = `https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=${nsn}&category=nsn`;

  const row = {
    sol_number: solNumber,
    nsn,
    quantity,
    unit_of_issue: null,
    issued_on: issuedOn,
    return_by: returnBy,
    status,
    amc: null,
    amsc: null,
    setaside: null,
    buyer_office: null,
    source: 'dibbs_rfq',
    nomenclature,
    fsc,
    source_url: sourceUrl,
    raw: rec,
  };

  return { row, nsn, fsc, nomenclature };
}
