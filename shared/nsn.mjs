// shared/nsn.mjs
// NSN / NIIN normalization and extraction helpers.
//
// An NSN (National Stock Number) is 13 digits: FSC (4 digits) + NIIN (9 digits).
// Dashed presentation form is 4-2-3-4, e.g. '5331-00-291-5924'.
//
// extractNiin() is used against free-text DLA award descriptions such as
// '8510240410!O-RING' where the token before '!' is a *purchase-request
// number* (commonly 9 OR 10+ digits) and must never be mistaken for a NIIN.
// Being conservative here matters: a wrong NSN attribution poisons a public
// price chart, which is strictly worse than no attribution at all.

/**
 * Normalizes free-form NSN input to a 13-digit digit-only string.
 * Accepts: 13 bare digits, dashed 4-2-3-4 groups, and/or surrounding or
 * interior whitespace. Returns null if the input does not reduce to exactly
 * 13 digits.
 *
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
export function normalizeNsn(input) {
  if (input === null || input === undefined) return null;
  const stripped = String(input).trim().replace(/[\s-]+/g, '');
  if (/^\d{13}$/.test(stripped)) return stripped;
  return null;
}

/**
 * Formats a 13-digit NSN string as dashed 4-2-3-4 presentation form, e.g.
 * '5331002915924' -> '5331-00-291-5924'. Returns null for invalid input.
 *
 * @param {string} nsn13
 * @returns {string|null}
 */
export function dashNsn(nsn13) {
  const n = normalizeNsn(nsn13);
  if (!n) return null;
  return `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9, 13)}`;
}

/**
 * Extracts the NIIN (last 9 digits) from a 13-digit NSN. Returns null for
 * invalid input.
 *
 * @param {string} nsn13
 * @returns {string|null}
 */
export function niinOf(nsn13) {
  const n = normalizeNsn(nsn13);
  if (!n) return null;
  return n.slice(4, 13);
}

// Delimited digit-run matchers: a lookbehind/lookahead of "not a digit"
// stands in for start-of-string/end-of-string/punctuation, so a 10-digit
// (or longer) run never accidentally yields a 9-digit substring, and a
// 13-digit run is claimed by the NSN patterns before the bare-NIIN fallback
// ever sees it.
const DASHED_NSN_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{3})-(\d{4})(?!\d)/;
const PLAIN_NSN_RE = /(?<![\dA-Za-z])(\d{13})(?![\dA-Za-z])/;
const BARE_NIIN_RE = /(?<![\dA-Za-z])(\d{9})(?![\dA-Za-z])/;

/**
 * Finds the first valid 9-digit NIIN in free text, e.g. a DLA award
 * description. Tries, in order:
 *
 *   1. A dashed 13-digit NSN pattern (FSC-CC-NNN-NNNN) -> its NIIN.
 *   2. A plain (undashed) delimited 13-digit run -> its NIIN (last 9 digits).
 *   3. A standalone delimited 9-digit run -> itself.
 *
 * A run is "delimited" when it is not immediately preceded or followed by
 * another digit (string boundary or punctuation both count). This means a
 * 10+-digit token (e.g. a purchase-request number like '8510240410') never
 * matches step 3 as a truncated NIIN, and is only claimed by steps 1/2 when
 * it is genuinely part of a full 13-digit NSN.
 *
 * Returns null when nothing matches. Conservative by design: no match is
 * preferred over a wrong match.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractNiin(text) {
  if (text === null || text === undefined) return null;
  const str = String(text);

  const dashedMatch = str.match(DASHED_NSN_RE);
  if (dashedMatch) {
    return dashedMatch[2] + dashedMatch[3] + dashedMatch[4];
  }

  const plainMatch = str.match(PLAIN_NSN_RE);
  if (plainMatch) {
    return plainMatch[1].slice(4, 13);
  }

  const bareMatch = str.match(BARE_NIIN_RE);
  if (bareMatch) {
    return bareMatch[1];
  }

  return null;
}

/**
 * Finds the first FULL 13-digit NSN in free text (dashed or plain forms
 * only — never synthesizes one from a bare NIIN). Use this before
 * extractNiin(): when a description carries its own complete NSN, that NSN's
 * own FSC is authoritative, and must not be overwritten by the record's PSC
 * (a PSC-5331 contract can reference a 5330-classified part).
 *
 * @param {string} text
 * @returns {string|null} 13-digit NSN or null
 */
export function extractNsn(text) {
  if (text === null || text === undefined) return null;
  const str = String(text);

  const dashedMatch = str.match(DASHED_NSN_RE);
  if (dashedMatch) {
    return dashedMatch[1] + dashedMatch[2] + dashedMatch[3] + dashedMatch[4];
  }

  const plainMatch = str.match(PLAIN_NSN_RE);
  if (plainMatch) {
    return plainMatch[1];
  }

  return null;
}
