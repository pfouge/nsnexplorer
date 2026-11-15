// FLIS code definitions the PUB LOG code dictionary (pub.flis_codes) does not carry, plus the small pure
// helpers the NSN page and markdown twin share to present dictionary text. No I/O, no imports.
//
// Provenance rule: every definition below was read from a US government source on 2026-11-15 and
// paraphrased in one short plain-language phrase. A code whose definition could not be read from an
// official source is NOT in its table, so the page shows the bare code with "definition not on file".

export const DEMIL_SOURCE_URL = 'https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodm/416028v2.PDF';
export const DEMIL_SOURCE_LABEL = 'DoD Manual 4160.28, Volume 2, Table 1 (DEMIL codes)';
export const DEMIL_SECONDARY_URL = 'https://www.dla.mil/What-DLA-Offers/Federal-and-International-Cataloging/DEMIL-Coding/DEMIL-Codes/';

/**
 * DEMIL (demilitarization) codes. Source: DoD Manual 4160.28 Volume 2, Table 1
 * https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodm/416028v2.PDF
 * cross-read against the DLA DEMIL Coding Management Office page
 * https://www.dla.mil/What-DLA-Offers/Federal-and-International-Cataloging/DEMIL-Coding/DEMIL-Codes/
 * Code B is worded differently in the two (the manual calls it obsolete for new assignments, the DLA page
 * still says "mutilate to scrap worldwide"); the manual is followed. Codes not listed (1-9, H, ...) were
 * not found in either source and stay unlabeled.
 */
export const DEMIL_CODES: Readonly<Record<string, string>> = {
  A: 'Low risk if released from DoD control; no demilitarization needed',
  B: 'Obsolete code, no longer assigned; formerly a Munitions List military item',
  C: 'Munitions or Commerce list item with key points that must be demilitarized',
  D: 'Munitions or Commerce list military item; demilitarization required',
  E: 'Needs a specific demilitarization method, or set by the DoD DEMIL program office',
  F: 'Military item; the item manager supplies special demilitarization instructions',
  G: 'Military item including ammunition and explosives; demilitarization required',
  P: 'Security-classified Munitions List item',
  Q: 'Commerce Control List item',
};

export const CRITICALITY_SOURCE_LABEL = 'DoD 4100.39-M, Volume 10, Table 181 (criticality code)';

/**
 * Criticality codes (FLIS CRIT_CD, DoD 4100.39-M Volume 10 Table 181 per the FLIS cataloging documentation).
 * INTENTIONALLY EMPTY: the table text could not be retrieved from an official source when this was written
 * (the DLA FLIS Technical Procedures Volume 10 copies - dla.mil CDTS_VOLUME_10.docx, the webharvest.gov and
 * UNT web-archive captures of dlis.dla.mil/PDFs/Procedures/vol10.pdf - were blocked or rate-limited), and the
 * only readable copies were commercial. Fill this in from Volume 10 Table 181 rather than from memory.
 */
export const CRITICALITY_CODES: Readonly<Record<string, string>> = {};

export const ESD_EMI_SOURCE_URL =
  'https://www.dla.mil/Logistics-Operations/Packaging/Packaging-FAQs/u106452q/456C656374726F73746174696320446973636861726765202845534429/';
export const ESD_EMI_SOURCE_LABEL = 'DoD Manual 4100.39, Volume 10, Table 189 (electrostatic discharge code), as quoted by DLA Packaging';

/**
 * ESD/EMI sensitivity codes (FLIS ESD_EMI). Source: DoD Manual 4100.39 Volume 10, Table 189
 * "Electrostatic Discharge Code (ESDC)", as quoted on the DLA Packaging FAQ page
 * https://www.dla.mil/Logistics-Operations/Packaging/Packaging-FAQs/u106452q/456C656374726F73746174696320446973636861726765202845534429/
 */
export const ESD_EMI_CODES: Readonly<Record<string, string>> = {
  A: 'No known ESD or EMI sensitivity',
  B: 'Sensitive to electrostatic discharge (ESD)',
  C: 'Sensitive to electromagnetic interference (EMI)',
  D: 'Sensitive to both ESD and EMI',
};

const norm = (code: string | null | undefined): string | null => {
  const c = (code ?? '').trim().toUpperCase();
  return c === '' ? null : c;
};

export const demilMeaning = (code: string | null | undefined): string | null => DEMIL_CODES[norm(code) ?? ''] ?? null;
export const criticalityMeaning = (code: string | null | undefined): string | null => CRITICALITY_CODES[norm(code) ?? ''] ?? null;
export const esdEmiMeaning = (code: string | null | undefined): string | null => ESD_EMI_CODES[norm(code) ?? ''] ?? null;

// ---------------------------------------------------------------------------------------------
// Dictionary text clean-up. pub.flis_codes is upper case with "~" line breaks, URLs and repeated
// "SEE VOLUME 10 ..." tails; the page wants sentence/title case and a short length.

const SMALL_WORDS = new Set(['of', 'the', 'and', 'for', 'to', 'in', 'on', 'a', 'an', 'or', 'at', 'by', 'with', 'from', 'as']);
// Tokens kept upper case when everything else is lower-cased.
const KEEP_UPPER = new Set([
  'DOD', 'DLA', 'US', 'U.S.', 'USA', 'UK', 'NSN', 'NIIN', 'FSC', 'AMC', 'AMSC', 'AAC', 'PICA', 'SICA', 'IMC', 'IMCA', 'ISC', 'INC', 'HMIC', 'HMIRS', 'HCC',
  'PMIC', 'ENAC', 'MSDS', 'FLIS', 'NATO', 'NAMSA', 'DRN', 'TIR', 'DLIS', 'USML', 'CCL', 'CAGE', 'IMM', 'IUID', 'GSA', 'NSA', 'DTRA', 'USSOCOM', 'USCG',
  'AFSOC', 'MARSOC', 'NAVSPECWARCOM', 'MOE', 'DEMIL', 'ESD', 'EMI', 'LOA', 'II', 'III', 'IV', 'HQ', 'AFB', 'MISMO', 'ICP', 'FED', 'STD', 'MIL', 'EAR',
]);

const keepsUpper = (t: string): boolean => {
  const core = t.replace(/^[^A-Z0-9]+/, '').replace(/[^A-Z0-9]+$/, ''); // "/PICA/." -> "PICA", "U.S." -> "U.S"
  if (core === '') return false;
  if (KEEP_UPPER.has(core)) return true;
  if (/^([A-Z]\.)+[A-Z]$/.test(core)) return true; // U.S.
  if (/\d/.test(core) && /[A-Z]/.test(core)) return true; // 4120.24-M, MIL-STD-130M, 3A
  return false;
};

const isAllUpper = (s: string): boolean => /[A-Z]/.test(s) && s === s.toUpperCase();

/** "DEPARTMENT OF THE ARMY" -> "Department of the Army". Mixed-case input is returned trimmed, untouched. */
export function humanizeLabel(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/~+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  if (!isAllUpper(s)) return s;
  let first = true;
  return s
    .split(/(\s+|[/,()-]+)/)
    .map((part) => {
      if (part === '' || /^(\s+|[/,()-]+)$/.test(part)) return part;
      const word = keepsUpper(part)
        ? part
        : SMALL_WORDS.has(part.toLowerCase()) && !first
          ? part.toLowerCase()
          : part.charAt(0) + part.slice(1).toLowerCase();
      first = false;
      return word;
    })
    .join('')
    .replace(/\bDOD\b/g, 'DoD');
}

/**
 * Dictionary definition -> short sentence-case text: line-break markers, URLs, "SEE VOLUME ..." references and
 * "MUST BE USED IN COMBINATION WITH DRN ..." boilerplate removed; at most `max` characters, cut at a word.
 */
export function cleanDefinition(raw: string | null | undefined, max = 200): string | null {
  let s = (raw ?? '').replace(/~+/g, ', ');
  s = s.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\/N\b/g, ' ');
  const cut = s.search(/\bSEE VOLUME\b/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/\bMUST BE USED IN COMBINATION WITH DRN \d+\.?/gi, ' ');
  s = s.replace(/\s+/g, ' ').replace(/(^|[.:])\s*,\s*/g, '$1 ').trim().replace(/[\s,]+$/, '');
  if (s === '') return null;
  if (isAllUpper(s)) {
    let start = true;
    s = s
      .split(/(\s+)/)
      .map((part) => {
        if (/^\s*$/.test(part)) return part;
        const word = keepsUpper(part) ? part : part.toLowerCase();
        const out = start ? word.charAt(0).toUpperCase() + word.slice(1) : word;
        start = /[.!?]$/.test(part);
        return out;
      })
      .join('')
      .replace(/\bDOD\b/g, 'DoD');
  }
  if (!/[.!?]$/.test(s)) s += '.';
  if (s.length <= max) return s;
  const clipped = s.slice(0, max - 1);
  const at = Math.max(clipped.lastIndexOf('. '), -1);
  if (at > max * 0.5) return clipped.slice(0, at + 1);
  return clipped.replace(/\s+\S*$/, '').replace(/[\s,;:]+$/, '') + '…';
}

// ---------------------------------------------------------------------------------------------
// Who is a US organization? MOE_CD values are two characters. Observed in pub.moe_rules / pub.flis_codes
// (2026-11): US federal organizations start with A B C D E F G H K L M Q R S T U X (DA Army, DF Air Force,
// DM Marine Corps, DN Navy, DS DLA, GP Coast Guard, TG GSA, T1 NASA ...), plus VA (Veterans
// Administration, the one V code that is not a foreign government). Foreign governments start with W, Y, Z
// (Austria ... Zimbabwe), V (except VA), I or O (African / Latin American countries). Everything else is
// "other": ZX (NATO Maintenance and Supply Agency, an organization, not a government), KA (a company),
// and any code that is not two letters/digits.
export type MoeKind = 'us' | 'foreign' | 'other';
const US_FIRST = 'ABCDEFGHKLMQRSTUX';
const FOREIGN_FIRST = 'WYZVIO';

export function moeKind(code: string | null | undefined): MoeKind {
  const c = norm(code);
  if (c === null || !/^[A-Z0-9]{2}$/.test(c)) return 'other';
  if (c === 'ZX' || c === 'KA') return 'other';
  if (c === 'VA') return 'us';
  if (FOREIGN_FIRST.includes(c[0])) return 'foreign';
  if (US_FIRST.includes(c[0])) return 'us';
  return 'other';
}
