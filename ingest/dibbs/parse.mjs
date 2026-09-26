// ingest/dibbs/parse.mjs
// Parser for the DIBBS award search-results page
// (/Awards/AwdRecs.aspx?category=post&TypeSrch=dt&Value=MM-DD-YYYY) — an
// ASP.NET GridView, NOT a batch/flat file. See
// docs/dibbs-ingest-findings.md "Award grid — CONFIRMED" for the live
// capture this module is built and tested against
// (ingest/dibbs/fixtures/awd-grid-p1.html, captured 2026-07-13).
//
// There is no batch-file counterpart on DIBBS any more — /Downloads/…
// paths are gone — so award data only exists as server-rendered HTML
// behind ASP.NET postback pagination (__doPostBack('ctl00$cph1$grdAwardSearch',
// 'Page$N')). This module is regex-based (the repo has no HTML-parser
// dependency) and relies on the grid's stable per-row span ids:
// `ctl00_cph1_grdAwardSearch_ctlNN_lbl<Field>`.
//
// Exports:
//   parseAwardGrid(html)     -> { records, recordCount }
//   parsePagination(html)    -> { gridId, pages }
//   extractAspNetForm(html)  -> { action, fields }
//
// parseAwardGrid does NOT normalize or validate NSNs — the grid's "NSN/Part
// Number" column can hold non-NSN local ids (e.g. 'DA10V00014345'); NSN
// validation/rejection is load.mjs's job via shared/nsn.mjs normalizeNsn.
// Likewise there is no quantity/unit-price column in the grid — only a
// total contract price — so records carry `total` only; the unit-price
// strategy is a separate, not-yet-made design decision (see
// docs/dibbs-ingest-findings.md "Next steps").

/**
 * Grid layout confirmed 2026-07-13 against the committed live-capture
 * fixture (ingest/dibbs/fixtures/awd-grid-p1.html — see
 * docs/dibbs-ingest-findings.md "Award grid — CONFIRMED"). The totals-only
 * load path (parseAwardGrid -> loadAwardGridActions -> pub.contract_actions)
 * is live and does not consult this flag. It now only gates the future
 * unit-price (pub.price_points) path in ingest/dibbs/load.mjs's
 * loadAwardRecords, which stays unimplemented/unconfirmed until the
 * unit-price strategy (RFQ-quantity join vs award-detail enrichment) is
 * decided.
 */
export const LAYOUT_CONFIRMED = true;

// Matches the opening <span id="ctl00_cph1_<gridName>_ctlNN_lblField"> tag
// for every labeled cell in every grid row. Capture group 1 is the row id
// (e.g. 'ctl03'), group 2 is the field name (e.g. 'lblAwardBasicNumber').
// The award grid (gridName 'grdAwardSearch') and RFQ grid (gridName
// 'grdRfqSearch', see parseRfqGrid below) are the exact same GridView
// shape, just different ids/columns — see groupGridRows.
/** Builds the row-span regex for an arbitrary `ctl00_cph1_<gridName>_ctlNN_lblField` grid. */
function gridRowSpanRe(gridName) {
  return new RegExp(`<span id="ctl00_cph1_${gridName}_(ctl\\d+)_(lbl[A-Za-z]+)"[^>]*>`, 'g');
}

// The handful of HTML entities the award grid actually emits. &raquo; is
// included (not just the four the spec calls out) because the
// AwardBasicNumber/DeliveryOrder cells append a "&raquo; <a>...Package
// View</a>" suffix after the value we actually want, and splitting on the
// decoded '»' character is how that suffix gets dropped (see
// textFromSpanContent below).
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  raquo: '»',
};

/** Decodes HTML entities found in DIBBS grid markup (named + numeric). */
function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent)
      ? NAMED_ENTITIES[ent]
      : whole;
  });
}

/** Removes all tags, replacing each with a single space (avoids gluing adjacent text nodes together). */
function stripTags(str) {
  return str.replace(/<[^>]*>/g, ' ');
}

/**
 * Turns a raw grid-cell span's inner HTML into the clean text value we
 * store. Strips tags, decodes entities, drops any "&raquo; ... Package
 * View" suffix some cells (AwardBasicNumber, DeliveryOrder) carry, collapses
 * whitespace, and treats '&nbsp;'/empty content as null.
 */
function textFromSpanContent(raw) {
  if (raw === undefined || raw === null) return null;
  let text = decodeEntities(stripTags(raw));
  const raquoIdx = text.indexOf('»');
  if (raquoIdx !== -1) text = text.slice(0, raquoIdx);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** Parses a '$8,644.84'-style total into a Number, or null if unparseable (e.g. 'See Award Doc'). */
function parseTotal(raw) {
  const text = textFromSpanContent(raw);
  if (text === null) return null;
  const cleaned = text.replace(/[$,]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Converts the grid's MM-DD-YYYY date text to 'YYYY-MM-DD', or null. */
function parseGridDate(raw) {
  const text = textFromSpanContent(raw);
  if (text === null) return null;
  const m = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Reads the content of a <span ...>…</span> starting right after its
 * opening tag, honoring nested <span> tags (the DeliveryOrder/
 * AwardBasicNumber cells nest a "Package View" link inside a bare <span>).
 * Returns { content, end } where `end` is the index right after the
 * matching closing tag.
 */
function readBalancedSpanContent(html, contentStart) {
  const tagRe = /<\/?span\b[^>]*>/gi;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let m;
  while ((m = tagRe.exec(html))) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return { content: html.slice(contentStart, m.index), end: tagRe.lastIndex };
    }
  }
  // Unbalanced — shouldn't happen against a real grid page; fall back to EOF.
  return { content: html.slice(contentStart), end: html.length };
}

/**
 * Groups every `<span id="ctl00_cph1_<gridName>_ctlNN_lblField">…</span>`
 * cell in `html` by row, preserving first-seen row order. Shared by
 * parseAwardGrid (gridName 'grdAwardSearch') and parseRfqGrid (gridName
 * 'grdRfqSearch') — both grids are the same ASP.NET GridView shape, just
 * different ids/columns.
 *
 * @param {string} html
 * @param {string} gridName e.g. 'grdAwardSearch' or 'grdRfqSearch'
 * @returns {{ rows: Map<string, Record<string,string>>, order: string[] }}
 */
function groupGridRows(html, gridName) {
  const rows = new Map(); // rowId ('ctlNN') -> { fieldName: rawInnerHtml }
  const order = [];

  const re = gridRowSpanRe(gridName);
  let m;
  while ((m = re.exec(html))) {
    const rowId = m[1];
    const field = m[2];
    const contentStart = re.lastIndex;
    const { content, end } = readBalancedSpanContent(html, contentStart);
    re.lastIndex = end;

    if (!rows.has(rowId)) {
      rows.set(rowId, {});
      order.push(rowId);
    }
    rows.get(rowId)[field] = content;
  }

  return { rows, order };
}

/**
 * Parses a DIBBS award grid page into normalized award records.
 *
 * @param {string} html
 * @returns {{ records: object[], recordCount: number }}
 */
export function parseAwardGrid(html) {
  const { rows, order } = groupGridRows(html, 'grdAwardSearch');

  const records = order.map((rowId) => {
    const f = rows.get(rowId);
    return {
      awardNumber: textFromSpanContent(f.lblAwardBasicNumber),
      deliveryOrder: textFromSpanContent(f.lblDeliveryOrder),
      cage: textFromSpanContent(f.lblCage),
      total: parseTotal(f.lblTotalContactPrice),
      awardDate: parseGridDate(f.lblAwardDate),
      postedDate: parseGridDate(f.lblPostedDate),
      nsnRaw: textFromSpanContent(f.lblNsn),
      nomenclature: textFromSpanContent(f.lblNomenclature),
      purchaseRequest: textFromSpanContent(f.lblPurchaseRequest),
      solicitation: textFromSpanContent(f.lblSolicitation),
    };
  });

  return { records, recordCount: records.length };
}

// Matches a dashed 13-digit NSN token, e.g. '8455-01-024-2960'.
const DASHED_NSN_RE = /^(\d{4})-(\d{2})-(\d{3})-(\d{4})$/;

/**
 * Parses the RFQ grid's Nsn cell, which packs a dashed NSN (or, sometimes,
 * some other raw identifier) and an optional trailing qualifier span (e.g.
 * 'Mil-Spec') separated by a line break:
 *   '<a ...>8455-01-024-2960</a><br /> <span ...>Mil-Spec</span>'
 * decodes/strips down to the text 'NNNN-NN-NNN-NNNN Mil-Spec'. Returns the
 * 13-digit compact form when the leading token is NSN-shaped, else the raw
 * token verbatim (mirrors parseAwardGrid's nsnRaw, which never normalizes).
 *
 * @param {string|undefined} raw
 * @returns {{ nsnRaw: string|null, nsnQualifier: string|null }}
 */
function parseNsnCell(raw) {
  const text = textFromSpanContent(raw);
  if (text === null) return { nsnRaw: null, nsnQualifier: null };

  const spaceIdx = text.indexOf(' ');
  const token = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const qualifier = spaceIdx === -1 ? null : (text.slice(spaceIdx + 1).trim() || null);

  const dashed = token.match(DASHED_NSN_RE);
  const nsnRaw = dashed ? dashed.slice(1).join('') : token;

  return { nsnRaw, nsnQualifier: qualifier };
}

/**
 * Parses the RFQ grid's Pr cell, which packs the purchase request number
 * and quantity separated by a line break: '7017413272<br />QTY: 20000'
 * decodes/strips down to '7017413272 QTY: 20000'.
 *
 * @param {string|undefined} raw
 * @returns {{ purchaseRequest: string|null, quantity: number|null }}
 */
function parsePrCell(raw) {
  const text = textFromSpanContent(raw);
  if (text === null) return { purchaseRequest: null, quantity: null };

  const withQty = text.match(/^(\d+)\s*QTY:\s*(-?[\d,]+(?:\.\d+)?)/i);
  if (withQty) {
    const qty = Number(withQty[2].replace(/,/g, ''));
    return { purchaseRequest: withQty[1], quantity: Number.isFinite(qty) ? qty : null };
  }

  const prOnly = text.match(/^(\d+)/);
  return { purchaseRequest: prOnly ? prOnly[1] : text, quantity: null };
}

/**
 * Parses a DIBBS RFQ grid page (`/Rfq/RfqRecs.aspx?category=post&TypeSrch=
 * dt&Value=MM-DD-YYYY`) into normalized RFQ records. Same GridView-postback
 * shape as the award grid (see docs/dibbs-ingest-findings.md and the
 * committed fixture ingest/dibbs/fixtures/rfq-grid-p1.html), grid id
 * `ctl00_cph1_grdRfqSearch`, row spans `..._ctlNN_lbl{RowNum,Nsn,
 * Nomenclature,TechnicalDocuments,Solicitation,Status,Pr,Issued,ReturnBy}`.
 *
 * @param {string} html
 * @returns {{ records: object[], recordCount: number }}
 */
export function parseRfqGrid(html) {
  const { rows, order } = groupGridRows(html, 'grdRfqSearch');

  const records = order.map((rowId) => {
    const f = rows.get(rowId);
    const { nsnRaw, nsnQualifier } = parseNsnCell(f.lblNsn);
    const { purchaseRequest, quantity } = parsePrCell(f.lblPr);
    return {
      nsnRaw,
      nsnQualifier,
      nomenclature: textFromSpanContent(f.lblNomenclature),
      techDocs: textFromSpanContent(f.lblTechnicalDocuments),
      solicitation: textFromSpanContent(f.lblSolicitation),
      status: textFromSpanContent(f.lblStatus),
      purchaseRequest,
      quantity,
      issued: parseGridDate(f.lblIssued),
      returnBy: parseGridDate(f.lblReturnBy),
    };
  });

  return { records, recordCount: records.length };
}

/**
 * Finds the GridView's postback pagination targets. DIBBS renders these as
 * javascript:__doPostBack('ctl00$cph1$grdAwardSearch','Page$N') links, with
 * the quotes HTML-entity-encoded (&#39;) since they sit inside an href
 * attribute. The pager only shows a window of nearby page numbers (e.g.
 * '...' beyond Page$11 on page 1 of a large result set) — callers must
 * re-parse each newly fetched page to discover further pages.
 *
 * @param {string} html
 * @returns {{ gridId: string|null, pages: string[] }} pages sorted ascending, e.g. ['Page$2', 'Page$3', ...]
 */
export function parsePagination(html) {
  const POSTBACK_RE =
    /__doPostBack\((?:&#39;|')([^'&]+)(?:&#39;|'),(?:&#39;|')([^'&]+)(?:&#39;|')\)/g;

  let gridId = null;
  const pageNums = new Set();
  let m;
  while ((m = POSTBACK_RE.exec(html))) {
    const target = m[1];
    const arg = m[2];
    const pageMatch = arg.match(/^Page\$(\d+)$/);
    if (pageMatch) {
      if (gridId === null) gridId = target;
      pageNums.add(Number(pageMatch[1]));
    }
  }

  const pages = [...pageNums].sort((a, b) => a - b).map((n) => `Page$${n}`);
  return { gridId, pages };
}

/**
 * Extracts the page's <form> action and every hidden input field (all
 * __VIEWSTATE0..N split parts, __VIEWSTATEFIELDCOUNT, __VIEWSTATEGENERATOR,
 * __VIEWSTATEENCRYPTED, __EVENTVALIDATION, and any other inputs present).
 * Same approach as capture-fixture.mjs's extractForm, generalized to keep
 * ALL inputs (not just hidden ones) since __EVENTTARGET/__EVENTARGUMENT
 * must be added by the caller on top of whatever's already present.
 *
 * @param {string} html
 * @returns {{ action: string, fields: Record<string, string> }}
 */
export function extractAspNetForm(html) {
  const formMatch = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!formMatch) return { action: '', fields: {} };

  const actionMatch = formMatch[1].match(/action\s*=\s*"([^"]*)"/i);
  const action = actionMatch ? decodeEntities(actionMatch[1]) : '';

  const fields = {};
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(formMatch[2]))) {
    const inputAttrs = m[1];
    // HIDDEN inputs only: posting button fields (ctl00$butDbSearch etc.)
    // makes ASP.NET raise that button's event instead of the pager
    // __EVENTTARGET, which silently re-renders page 1 on every "next
    // page" postback (the bug behind duplicated pagination captures).
    const typeMatch = inputAttrs.match(/type\s*=\s*"([^"]*)"/i);
    if (!typeMatch || typeMatch[1].toLowerCase() !== 'hidden') continue;
    const nameMatch = inputAttrs.match(/name\s*=\s*"([^"]*)"/i);
    if (!nameMatch) continue;
    const valueMatch = inputAttrs.match(/value\s*=\s*"([^"]*)"/i);
    fields[nameMatch[1]] = valueMatch ? decodeEntities(valueMatch[1]) : '';
  }

  return { action, fields };
}
