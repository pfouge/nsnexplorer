// Query-led titles, meta descriptions and on-page summaries for the class,
// group and NSN templates. Pure functions over plain values (no I/O, no
// imports) so they run unchanged at build time, in the Workers runtime and
// under `node --test`.
//
// Titles are returned WITHOUT the site suffix (the SEO component appends
// " · NSN Explorer"). Descriptions are built from ordered clauses and trimmed
// by dropping trailing clauses until they fit MAX_DESCRIPTION (never by
// cutting a clause in half).

export const MAX_DESCRIPTION = 160;

const int = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string = `${one}s`): string => `${int(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Item names

const VOWELS = /[AEIOU]/i;

/**
 * FLIS item names are SHOUTED and comma-packed ("CLIP,RETAINING"). Turns them
 * into readable Title Case ("Clip, Retaining"). Tokens containing digits and
 * short (<= 3 letters) all-consonant tokens (RH, PVC, SS) stay upper-case.
 * A missing name reads "Unnamed Item".
 */
export function nomen(itemName: string | null | undefined): string {
  const raw = (itemName ?? '').replace(/\s+/g, ' ').trim();
  if (raw === '') return 'Unnamed Item';
  return raw
    .replace(/\s*,\s*/g, ', ')
    .replace(/[A-Za-z0-9']+/g, (tok) => {
      if (/\d/.test(tok)) return tok.toUpperCase();
      const letters = tok.replace(/[^A-Za-z]/g, '');
      if (letters.length <= 3 && !VOWELS.test(letters)) return tok.toUpperCase();
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .replace(/,\s*$/, '');
}

/** Lower-cases a title-case name for use mid-sentence, keeping acronyms ("IT", "FLIS") and digits. */
export function lowerName(name: string): string {
  return name
    .split(/(\s+)/)
    .map((w) => (/^[A-Z0-9]{2,}[,;]?$/.test(w) || /\d/.test(w) ? w : w.toLowerCase()))
    .join('');
}

/** 'a' or 'an' for the phrase that follows. */
export function article(phrase: string): 'a' | 'an' {
  return /^[aeiou]/i.test(phrase.trim()) ? 'an' : 'a';
}

/** The class name when it is a real handbook title; null for ingest placeholders ('FSC 7310') and blanks. */
export function listedFscName(code: string, name: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  return n === '' || n === `FSC ${code}` ? null : n;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-14' -> 'Mar 2026' (null for anything that is not an ISO date). */
export function monthYear(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(iso ?? '');
  if (!m) return null;
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${mon} ${m[1]}` : null;
}

// ---------------------------------------------------------------------------
// Descriptions

/** A clause, or alternatives for it from longest to shortest (used for the first, mandatory clause). */
export type Clause = string | string[];

/**
 * Joins clauses in order and keeps the longest leading run that fits `max`
 * (counting `prefix`). A first clause given as alternatives falls back to the
 * next, shorter one only when the longer one does not fit even on its own. Never
 * cuts inside a clause; the word-boundary trim at the end is a last resort
 * that real data does not reach (covered by tests).
 */
export function fitDescription(clauses: Clause[], opts: { max?: number; prefix?: string } = {}): string {
  const max = opts.max ?? MAX_DESCRIPTION;
  const prefix = opts.prefix ?? '';
  const heads = Array.isArray(clauses[0]) ? clauses[0] : [clauses[0] ?? ''];
  const rest = clauses.slice(1).map((c) => (Array.isArray(c) ? c[0] : c));
  // Trailing clauses go first; a shorter first clause is used only when even
  // the first clause alone (with the prefix) is too long.
  for (const head of heads) {
    for (let keep = rest.length; keep >= 0; keep--) {
      const text = prefix + head + rest.slice(0, keep).join('');
      if (text.length <= max) return text;
    }
  }
  const shortest = prefix + heads[heads.length - 1];
  const cut = shortest.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// /fsc/<code>/

export interface FscCopyInput {
  code: string;
  /** Real class name, or null when the code is unlisted (placeholder name). */
  name: string | null;
  nsnCount: number;
  openCount: number;
}

export function fscTitle(i: FscCopyInput): string {
  const n = plural(i.nsnCount, 'NSN');
  if (i.name === null) return `FSC ${i.code} (Unlisted Supply Class): ${n}`;
  return i.openCount > 0
    ? `FSC ${i.code} ${i.name}: ${n}, Prices & Open RFQs`
    : `FSC ${i.code} ${i.name}: ${n}, Specs & Award Prices`;
}

export function fscDescription(i: FscCopyInput, prefix = ''): string {
  const n = plural(i.nsnCount, 'NSN');
  if (i.name === null) {
    return fitDescription(
      [
        [`${n} in FSC ${i.code}, a supply class the federal handbook does not list.`, `${n} in FSC ${i.code}, an unlisted supply class.`],
        ' Specs, part numbers and award records, linked to government sources.',
      ],
      { prefix }
    );
  }
  return fitDescription(
    [
      [`Browse ${n} in FSC ${i.code} ${i.name}: specs, part numbers and award prices.`, `${n} in FSC ${i.code} ${i.name}.`],
      i.openCount > 0 ? ` ${plural(i.openCount, 'open solicitation')}.` : '',
      ' Free, linked to government source records.',
    ],
    { prefix }
  );
}

// ---------------------------------------------------------------------------
// /open/<code>/

export interface OpenCopyInput {
  code: string;
  name: string | null;
  /** Open solicitations right now. */
  openCount: number;
  /** Distinct NSNs among them. */
  nsnCount: number;
}

export function openTitle(i: OpenCopyInput): string {
  if (i.openCount === 0) {
    return i.name === null ? `FSC ${i.code} Solicitations: None Open Now` : `FSC ${i.code} Solicitations for ${i.name}: None Open Now`;
  }
  const rfqs = i.openCount === 1 ? `${int(i.openCount)} RFQ` : `${int(i.openCount)} RFQs`;
  return i.name === null ? `FSC ${i.code} Open Solicitations: ${rfqs}` : `FSC ${i.code} Open Solicitations: ${rfqs} for ${i.name}`;
}

export function openDescription(i: OpenCopyInput, prefix = ''): string {
  const label = i.name === null ? `FSC ${i.code}` : `FSC ${i.code} ${i.name}`;
  if (i.openCount === 0) {
    return fitDescription(
      [
        [`No open DLA solicitations for ${label} right now; closed RFQs stay on record with quantities and dates.`, `No open DLA solicitations for ${label} right now.`],
        ' Updated daily.',
      ],
      { prefix }
    );
  }
  const k = plural(i.openCount, 'open DLA solicitation');
  return fitDescription(
    [
      [`${k} for ${label} across ${plural(i.nsnCount, 'NSN')}, with quantities and closing dates.`, `${k} for ${label}.`],
      ' Linked to the official RFQ.',
      ' Updated daily.',
    ],
    { prefix }
  );
}

// ---------------------------------------------------------------------------
// /group/<fsg>/

export interface GroupCopyInput {
  fsg: string;
  name: string;
  classCount: number;
  nsnCount: number;
}

export function groupTitle(i: GroupCopyInput): string {
  return `FSG ${i.fsg} ${i.name}: ${plural(i.classCount, 'Supply Class', 'Supply Classes')}, ${plural(i.nsnCount, 'NSN')}`;
}

export function groupDescription(i: GroupCopyInput): string {
  const c = plural(i.classCount, 'supply class', 'supply classes');
  const n = plural(i.nsnCount, 'NSN');
  return fitDescription([
    [
      `Federal Supply Group ${i.fsg}, ${i.name}: ${c} and ${n} with specs, part numbers, award prices and open solicitations.`,
      `Federal Supply Group ${i.fsg}, ${i.name}: ${c} and ${n}.`,
      `FSG ${i.fsg} ${i.name}: ${c}, ${n}.`,
    ],
  ]);
}

export interface GroupIntroInput extends GroupCopyInput {
  /** Largest classes first, with a display name already resolved. */
  topClasses: { label: string; nsnCount: number }[];
  openCount: number;
}

/** Paragraph under the group h1: what the group covers, how big it is, and its biggest classes. */
export function groupIntro(i: GroupIntroInput): string {
  const top = i.topClasses.slice(0, 3).map((c) => `${c.label} (${int(c.nsnCount)})`);
  const list = top.length <= 1 ? top.join('') : `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}`;
  const largest = top.length === 0 ? '' : top.length === 1 ? ` The only class tracked so far is ${list}.` : ` The largest are ${list}.`;
  const open = i.openCount > 0 ? ` ${plural(i.openCount, 'solicitation')} ${i.openCount === 1 ? 'is' : 'are'} open in this group today.` : '';
  return (
    `Federal Supply Group ${i.fsg} covers ${lowerName(i.name)}. NSN Explorer tracks ${plural(i.nsnCount, 'stock number')} ` +
    `across ${plural(i.classCount, 'supply class', 'supply classes')} in this group.${largest}${open}`
  );
}

// ---------------------------------------------------------------------------
// /nsn/<nsn>/ and /nsn/<nsn>.md

export interface NsnCopyInput {
  /** NNNN-NN-NNN-NNNN */
  dashed: string;
  itemName: string | null;
  fscCode: string;
  /** Real class name, or null when unlisted / unknown. */
  fscName: string | null;
  pricePoints: number;
  openSolicitations: number;
  hasCharacteristics: boolean;
  partNumbers: number;
  /** Distinct manufacturer/supplier CAGE codes across the part numbers. */
  suppliers: number;
  /** ISO date of the newest purchase record, if any. */
  lastPurchased: string | null;
}

export function nsnFacet(i: NsnCopyInput): string {
  if (i.pricePoints >= 1) return 'Price History & Specs';
  if (i.openSolicitations >= 1) return 'Open RFQ & Specs';
  if (i.hasCharacteristics || i.partNumbers >= 1) return 'Specs & Part Numbers';
  return 'Item Details';
}

export function nsnTitle(i: NsnCopyInput): string {
  return `NSN ${i.dashed} ${nomen(i.itemName)}: ${nsnFacet(i)}`;
}

/** "FSC 5340 Hardware, Commercial" / "FSC 7310 (unlisted supply class)" / "FSC 7310". */
export function fscLabel(code: string, name: string | null, listed: boolean = true): string {
  if (name !== null) return `FSC ${code} ${name}`;
  return listed ? `FSC ${code} (unlisted supply class)` : `FSC ${code}`;
}

export function nsnDescription(i: NsnCopyInput): string {
  const named = i.itemName !== null && i.itemName.trim() !== '';
  const where = fscLabel(i.fscCode, i.fscName);
  const first = named ? `NSN ${i.dashed} (${nomen(i.itemName)}) in ${where}.` : `NSN ${i.dashed} in ${where}.`;
  const pn =
    i.partNumbers > 0
      ? i.suppliers > 0
        ? ` ${plural(i.partNumbers, 'part number')} from ${plural(i.suppliers, 'supplier')}.`
        : ` ${plural(i.partNumbers, 'part number')}.`
      : '';
  const monthYr = monthYear(i.lastPurchased);
  const demand = i.openSolicitations > 0 ? ` ${plural(i.openSolicitations, 'open solicitation')}.` : monthYr ? ` Last award ${monthYr}.` : '';
  return fitDescription([first, pn, demand, ' Free, linked to source records.']);
}

/** '5340000000001' -> '00-000-0001' */
export function niinDashed(nsn13: string): string {
  const niin = nsn13.slice(4, 13);
  return `${niin.slice(0, 2)}-${niin.slice(2, 5)}-${niin.slice(5, 9)}`;
}

/** Plain-text summary paragraph shared by the HTML page (under the h1) and the .md version. */
export function nsnSummary(i: NsnCopyInput & { nsn13: string }): string {
  const name = nomen(i.itemName);
  const thing = i.itemName !== null && i.itemName.trim() !== '' ? name.toLowerCase() : 'unnamed item';
  const cls =
    i.fscName !== null
      ? `Federal Supply Class ${i.fscCode}, ${i.fscName}`
      : `Federal Supply Class ${i.fscCode}`;
  const head = `NSN ${i.dashed} (also written ${i.nsn13}; NIIN ${niinDashed(i.nsn13)}) is ${article(thing)} ${thing} in ${cls}.`;
  const pn =
    i.partNumbers > 0
      ? i.suppliers > 0
        ? ` ${plural(i.partNumbers, 'manufacturer part number')} from ${plural(i.suppliers, 'supplier')} ${i.partNumbers === 1 ? 'is' : 'are'} on record.`
        : ` ${plural(i.partNumbers, 'manufacturer part number')} ${i.partNumbers === 1 ? 'is' : 'are'} on record.`
      : '';
  const monthYr = monthYear(i.lastPurchased);
  const demand =
    i.openSolicitations > 0
      ? ` The government has ${plural(i.openSolicitations, 'open solicitation')} for it.`
      : monthYr
        ? ` It was last purchased in ${monthYr}.`
        : ' No purchases are on record yet.';
  return `${head}${pn}${demand}`;
}
