// Pure helpers and types for the /services/ section (open SAM.gov SERVICE
// notices). No I/O and no pg import: safe to bundle anywhere and to unit-test
// directly. The build-time query that feeds ServiceNotice lives in data.ts.

/** Product/Service Code category letters -> display names. */
export const SERVICE_CATEGORIES: Record<string, string> = {
  A: 'Research and development',
  B: 'Special studies and analyses',
  C: 'Architect and engineering services',
  D: 'IT and telecommunications',
  E: 'Purchase of structures and facilities',
  F: 'Natural resources management',
  G: 'Social services',
  H: 'Quality control, testing and inspection',
  J: 'Equipment maintenance, repair and rebuilding',
  K: 'Equipment modification',
  L: 'Technical representative services',
  M: 'Operation of government-owned facilities',
  N: 'Equipment installation',
  P: 'Salvage services',
  Q: 'Medical services',
  R: 'Professional, administrative and management support',
  S: 'Utilities and housekeeping',
  T: 'Photographic, mapping, printing and publication services',
  U: 'Education and training',
  V: 'Transportation, travel and relocation',
  W: 'Equipment lease or rental',
  X: 'Facility lease or rental',
  Y: 'Construction of structures and facilities',
  Z: 'Maintenance, repair or alteration of real property',
};

/** Display name for a category letter (or 'other'). */
export function serviceCategoryName(letter: string): string {
  const L = letter.toUpperCase();
  if (letter === 'other') return 'Uncoded notices';
  return SERVICE_CATEGORIES[L] ?? `Other services (code ${L})`;
}

/** Category name for a heading sentence: first letter lowercased unless it is "IT". */
export function serviceCategoryNameInline(letter: string): string {
  const name = serviceCategoryName(letter);
  return name.startsWith('IT ') ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/** 'J059' -> 'J'; anything that is not a letter-led 4-character code -> null. */
export function serviceCategoryOf(psc: string | null | undefined): string | null {
  if (typeof psc !== 'string') return null;
  const code = psc.trim();
  return /^[A-Z][A-Z0-9]{3}$/i.test(code) ? code.charAt(0).toUpperCase() : null;
}

/**
 * Two-digit supply group an equipment-service code points at:
 * J/K/L/N/W 0NN -> NN, and H1NN/H2NN/H3NN/H9NN -> NN. Otherwise null.
 */
export function equipmentGroupOf(psc: string | null | undefined): string | null {
  if (typeof psc !== 'string') return null;
  const code = psc.trim();
  const m = code.match(/^[JKLNW]0(\d\d)$/i) ?? code.match(/^H[1239](\d\d)$/i);
  return m ? m[1] : null;
}

const SMALL_WORDS = new Set(['of', 'the', 'and', 'for', 'on', 'in', 'to']);
// Ordinary short words that are not acronyms (so they are not kept upper-case).
const SHORT_PLAIN_WORDS = new Set(['dept', 'navy', 'army', 'air', 'corp']);

function titleCaseWords(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // Acronyms of up to 4 letters stay upper-case (GSA, NASA, USDA, U.S.).
      if (word.length <= 4 && !SHORT_PLAIN_WORDS.has(lower) && !SMALL_WORDS.has(lower)) return word.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** First dot-separated segment of SAM's fullParentPathName, title-cased. */
export function agencyOf(buyerOffice: string | null | undefined): string | null {
  if (typeof buyerOffice !== 'string') return null;
  const first = buyerOffice.split('.')[0]?.trim();
  return first ? titleCaseWords(first) : null;
}

/** Last dot-separated segment (the contracting office), trimmed. */
export function officeOf(buyerOffice: string | null | undefined): string | null {
  if (typeof buyerOffice !== 'string') return null;
  const parts = buyerOffice.split('.').map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

export interface ServiceNotice {
  solNumber: string;
  title: string | null;
  /** Product/service code, upper-cased; null when SAM sent none. */
  psc: string | null;
  /** Category letter ('J'), or 'other' when there is no usable code. */
  category: string;
  /** Two-digit supply group for equipment services, else null. */
  fsg: string | null;
  agency: string | null;
  office: string | null;
  setaside: string | null;
  naics: string | null;
  noticeType: string | null;
  state: string | null;
  postedOn: string | null; // ISO date
  closesOn: string | null; // ISO date
  sourceUrl: string;
}

/** Raw row shape returned by the build-time query in data.ts. */
export interface ServiceNoticeRow {
  sol_number: string;
  nomenclature: string | null;
  fsc: string | null;
  setaside: string | null;
  buyer_office: string | null;
  issued_on: string | Date | null;
  return_by: string | Date | null;
  source_url: string;
  naics: string | null;
  notice_type: string | null;
  setaside_desc: string | null;
  state: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};
const isoDate = (v: string | Date | null): string | null => (v ? new Date(v).toISOString().slice(0, 10) : null);

export function mapServiceNotice(r: ServiceNoticeRow): ServiceNotice {
  const psc = clean(r.fsc)?.toUpperCase() ?? null;
  return {
    solNumber: r.sol_number,
    title: clean(r.nomenclature),
    psc,
    category: serviceCategoryOf(psc) ?? 'other',
    fsg: equipmentGroupOf(psc),
    agency: agencyOf(r.buyer_office),
    office: officeOf(r.buyer_office),
    setaside: clean(r.setaside_desc) ?? clean(r.setaside),
    naics: clean(r.naics),
    noticeType: clean(r.notice_type),
    state: clean(r.state),
    postedOn: isoDate(r.issued_on),
    closesOn: isoDate(r.return_by),
    sourceUrl: r.source_url,
  };
}

/** Closing soonest first, no closing date last, then solicitation number. */
export function compareByClosing(a: ServiceNotice, b: ServiceNotice): number {
  if (a.closesOn !== b.closesOn) {
    if (a.closesOn === null) return 1;
    if (b.closesOn === null) return -1;
    return a.closesOn.localeCompare(b.closesOn);
  }
  return a.solNumber.localeCompare(b.solNumber);
}

export function daysUntil(closesOn: string | null, todayMs: number): number | null {
  if (!closesOn) return null;
  return Math.ceil((new Date(`${closesOn}T00:00:00Z`).getTime() - todayMs) / 86400000);
}

export interface ClosesLabel {
  text: string;
  cls: 'green' | 'amber' | '';
}

/** Same wording as the open-demand pages; null date reads "No closing date". */
export function closesLabel(d: number | null): ClosesLabel {
  if (d === null) return { text: 'No closing date', cls: '' };
  if (d <= 0) return { text: 'closes today', cls: 'amber' };
  if (d <= 2) return { text: `closes in ${d}d`, cls: 'amber' };
  return { text: `closes in ${d}d`, cls: 'green' };
}

/**
 * Value the /services/<letter>/ filter selects (and each card's data-setaside /
 * data-agency carries) for "no set-aside" / "unknown agency". The charts that
 * link into the filter use the same literal.
 */
export const FILTER_NONE = '__none';
