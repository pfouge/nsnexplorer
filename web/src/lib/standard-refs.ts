// standard-refs.ts: pure parser for the standards and specifications that define a part.
//
// Many parts are drawn by a government or industry standard, not by a one-off drawing: the standard's
// document (an MS sheet, an AN sheet, a MIL-DTL spec, an NAS drawing) holds the dimensioned table. This file finds
// those document numbers in the two places our data carries them and says where a supplier can get each one:
//
//   1. FLIS characteristics replies (pub.nsns.characteristics, e.g. "81349-MIL-DTL-25988 CLASS 1").
//   2. Part numbers (pub.part_numbers): MS35338-44 under CAGE 96906 IS the standard sheet MS35338, dash number 44.
//
// Access classes (what the page may say; we never host or copy any document):
//   'assist'  government document listed in ASSIST Quick Search (MS, AN, MIL-*, DOD-*, federal specs, A-A CIDs);
//   'adopted' industry document adopted by DoD: ASSIST lists the adoption notice, the full text is sold by its publisher;
//   'sold'    industry standard sold by its publisher (NAS/NASM by AIA, AS/AMS/SAE J by SAE, ASTM, ASME, ISO): no link.
//
// No imports at all, so plain `node --test` loads it and the browser filter code can too.

export type StdAccess = 'assist' | 'adopted' | 'sold';
export type StdPublisher = 'SAE' | 'AIA' | 'ASTM' | 'ASME' | 'ISO';
export type StdFamily =
  | 'MS' | 'AN' | 'MIL-STD' | 'MIL-HDBK' | 'MIL-DTL' | 'MIL-PRF' | 'MIL' | 'DOD' | 'FED' | 'CID' | 'M-SHEET'
  | 'ADOPTED' | 'NAS' | 'NASM' | 'AS' | 'AMS' | 'SAE-J' | 'ASTM' | 'ASME' | 'ISO';

export interface StandardRef {
  /** Normalised document id without revision, e.g. 'MS35338', 'MIL-DTL-25988', 'A-A-59326', 'AMS7276', 'ASTM B209'. */
  id: string;
  family: StdFamily;
  access: StdAccess;
  /** Who sells the document ('sold') or the full text of an adopted one; null for government documents. */
  publisher: StdPublisher | null;
  /** Plain-language kind, e.g. 'Military standard (MS) sheet'. */
  what: string;
  /** Revision letter or year when the text carried one (never part of `id`). */
  revision: string | null;
  /** Text after the sheet number when the id came from a sheet part number or text such as MS35338-44: '44', '4-6', 'C10'. */
  suffix: string | null;
  /** 'dash' when the suffix followed a hyphen (a dash number), 'code' when letters were attached (AN960C10). */
  suffixStyle: 'dash' | 'code' | null;
  /** True when a rule had to guess where the sheet number ends (MS35338144) or repair truncated text. */
  inferred: boolean;
  /** What to type in ASSIST's Document ID box (ASSIST accepts partial ids). */
  searchTerm: string;
}

export interface StandardDoc extends StandardRef {
  /** Where we saw it. */
  sources: ('part_number' | 'characteristic')[];
  /** Part numbers (as stored) whose own number is this sheet, with suffix. */
  partNumbers: { partNumber: string; suffix: string | null; suffixStyle: 'dash' | 'code' | null; govCage: boolean }[];
}

/**
 * Government CAGE codes whose "part numbers" are standard numbers themselves.
 * 96906 Military Standards (MS), 88044 Aeronautical Standards Group (AN), 80205 National Aerospace Standards (NAS),
 * 81349 Military specifications and standards, 81348 Federal specifications and standards. (Set from the request; the
 * CAGE titles are the ones in the public CAGE directory, to be rechecked in the report.)
 */
export const STANDARD_CAGES: ReadonlySet<string> = new Set(['96906', '88044', '80205', '81349', '81348']);

/** ASSIST Quick Search, DoD's public document search. No query-string form is documented by DLA, so we link the site. */
export const ASSIST_QUICK_SEARCH_URL = 'https://quicksearch.dla.mil/';

export const PUBLISHER_NAME: Record<StdPublisher, string> = {
  SAE: 'SAE International',
  AIA: 'the Aerospace Industries Association (AIA)',
  ASTM: 'ASTM International',
  ASME: 'ASME',
  ISO: 'ISO',
};

/** Short label for chips and badges: 'SAE', 'AIA', 'ASTM', 'ASME', 'ISO'. */
export const PUBLISHER_SHORT: Record<StdPublisher, string> = { SAE: 'SAE', AIA: 'AIA', ASTM: 'ASTM', ASME: 'ASME', ISO: 'ISO' };

const WHAT: Record<StdFamily, string> = {
  MS: 'Military standard (MS) sheet',
  AN: 'Air Force-Navy aeronautical (AN) standard',
  'MIL-STD': 'Military standard',
  'MIL-HDBK': 'Military handbook',
  'MIL-DTL': 'Military detail specification',
  'MIL-PRF': 'Military performance specification',
  MIL: 'Military specification',
  DOD: 'Department of Defense document',
  FED: 'Federal specification',
  CID: 'Commercial item description',
  'M-SHEET': 'Military specification sheet (catalog "M" number)',
  ADOPTED: 'Industry document adopted by DoD',
  NAS: 'National Aerospace Standard (NAS)',
  NASM: 'National Aerospace Standard, military-derived (NASM)',
  AS: 'SAE Aerospace Standard',
  AMS: 'SAE Aerospace Material Specification',
  'SAE-J': 'SAE J-series standard',
  ASTM: 'ASTM standard',
  ASME: 'ASME / ANSI standard',
  ISO: 'ISO standard',
};

const FED_PREFIX = '(?:FF|GG|HH|KK|LL|MM|NN|PPP|QQ|RR|SS|TT|UU|VV|WW|ZZ)';
const LB = '(?<![A-Z0-9])';
const RB = '(?![A-Z0-9])';
// Dash-number tail after a sheet number: -44, -4-6, -10L, -214. Starts with a digit; at most one more dash group.
const TAIL = '(?:-(\\d[0-9A-Z]{0,5}(?:-\\d{1,3}[A-Z]?)?))?';

interface Rule {
  family: StdFamily;
  re: RegExp;
  build: (m: RegExpExecArray) => Partial<StandardRef> | null;
}

const blank = (family: StdFamily, access: StdAccess, publisher: StdPublisher | null, id: string): StandardRef => ({
  id,
  family,
  access,
  publisher,
  what: WHAT[family],
  revision: null,
  suffix: null,
  suffixStyle: null,
  inferred: false,
  searchTerm: id,
});

const RULES: Rule[] = [
  // SAE-AMS-P-83461, SAE-AMS7276, SAE-AS22759/11, AMS-QQ-A-250/4: ASSIST-style ids of DoD-adopted industry documents.
  {
    family: 'ADOPTED',
    re: new RegExp(
      `${LB}((?:SAE-)?AMS-(?:[A-Z]{1,4}-){1,2}\\d{1,6}|SAE-AMS\\d{4}|SAE-AS\\d{3,5})([A-Z])?(\\/\\d{1,3}[A-Z]?)?${RB}`,
      'g'
    ),
    build: (m) => ({
      family: 'ADOPTED',
      access: 'adopted',
      publisher: 'SAE',
      id: m[1] + (m[3] ?? ''),
      revision: m[2] ?? null,
      searchTerm: m[1] + (m[3] ?? ''),
    }),
  },
  // MIL-DTL-25988C, MIL-PRF-81322G, MIL-STD-130N, MIL-S-8879, MIL-DTL-83513/01G, DOD-STD-100.
  {
    family: 'MIL',
    re: new RegExp(`${LB}((?:MIL|DOD)-(?:STD|HDBK|DTL|PRF|PRE|BUL|[A-Z]{1,4}))-(\\d{1,6})([A-Z](?![A-Z0-9]))?(?:\\/(\\d{1,3})([A-Z])?)?${RB}`, 'g'),
    build: (m) => {
      const kind = m[1];
      const family: StdFamily = kind.startsWith('DOD')
        ? 'DOD'
        : kind === 'MIL-STD'
          ? 'MIL-STD'
          : kind === 'MIL-HDBK'
            ? 'MIL-HDBK'
            : kind === 'MIL-DTL'
              ? 'MIL-DTL'
              : kind === 'MIL-PRF'
                ? 'MIL-PRF'
                : 'MIL';
      const id = `${kind}-${m[2]}${m[4] ? `/${m[4]}` : ''}`;
      return { family, access: 'assist', publisher: null, what: WHAT[family], id, searchTerm: id, revision: m[5] ?? m[3] ?? null };
    },
  },
  // QQ-A-250/4, FF-W-84, ZZ-R-765, PPP-B-601: federal specifications.
  {
    family: 'FED',
    re: new RegExp(`${LB}(${FED_PREFIX}-[A-Z]-\\d{1,5})([A-Z](?![A-Z0-9]))?(?:\\/(\\d{1,3})([A-Z])?)?${RB}`, 'g'),
    build: (m) => {
      const id = m[1] + (m[3] ? `/${m[3]}` : '');
      return { id, searchTerm: id, revision: m[4] ?? m[2] ?? null };
    },
  },
  // A-A-59326, A-A-52480: commercial item descriptions.
  {
    family: 'CID',
    re: new RegExp(`${LB}(A-A-\\d{3,5})([A-Z](?![A-Z0-9]))?(?:\\/(\\d{1,3})([A-Z])?)?${RB}`, 'g'),
    build: (m) => {
      const id = m[1] + (m[3] ? `/${m[3]}` : '');
      return { id, searchTerm: id, revision: m[4] ?? m[2] ?? null };
    },
  },
  // NASM1312, NAM2000: military-derived NAS (inch NASM, metric NAM).
  {
    family: 'NASM',
    re: new RegExp(`${LB}(NASM|NAM)(\\d{4,5})${TAIL}${RB}`, 'g'),
    build: (m) => ({ id: `${m[1]}${m[2]}`, searchTerm: `${m[1]}${m[2]}`, suffix: m[3] ?? null, suffixStyle: m[3] ? 'dash' : null }),
  },
  // NAS1352-4-6, NAS514P428, NAS 1352: National Aerospace Standard.
  {
    family: 'NAS',
    re: new RegExp(`${LB}NAS[ -]?(\\d{3,4})(?:-(\\d[0-9A-Z]{0,5}(?:-\\d{1,3}[A-Z]?)?)|([A-Z]\\d{1,4}[A-Z]?))?${RB}`, 'g'),
    build: (m) => ({
      id: `NAS${m[1]}`,
      searchTerm: `NAS${m[1]}`,
      suffix: m[2] ?? m[3] ?? null,
      suffixStyle: m[2] ? 'dash' : m[3] ? 'code' : null,
    }),
  },
  // MS35338-44, MS21042L3, MS3367-7-9, MS35338144 (digits only: split guessed).
  {
    family: 'MS',
    re: new RegExp(`${LB}MS[ -]?(\\d{3,9})(?:-(\\d[0-9A-Z]{0,5}(?:-\\d{1,3}[A-Z]?)?)|([A-Z]\\d{1,3}[A-Z]?))?${RB}`, 'g'),
    build: (m) => {
      const digits = m[1];
      if (digits.length > 5 && m[2] === undefined && m[3] === undefined) {
        // MS35338144: the sheet number is the first five digits (every MS sheet number seen with a dash is 4 or 5 digits).
        return { id: `MS${digits.slice(0, 5)}`, searchTerm: `MS${digits.slice(0, 5)}`, suffix: digits.slice(5), suffixStyle: 'dash', inferred: true };
      }
      if (digits.length > 5) return null;
      return {
        id: `MS${digits}`,
        searchTerm: `MS${digits}`,
        suffix: m[2] ?? m[3] ?? null,
        suffixStyle: m[2] ? 'dash' : m[3] ? 'code' : null,
      };
    },
  },
  // AN960-10, AN960C10, AN3H5A, AN 960.
  {
    family: 'AN',
    re: new RegExp(`${LB}AN[ -]?(\\d{1,4})(?:-(\\d[0-9A-Z]{0,5}(?:-\\d{1,3}[A-Z]?)?)|([A-Z]\\d{1,3}[A-Z]?))?${RB}`, 'g'),
    build: (m) => {
      // A bare "AN 5" in prose is far more likely not a standard: require 2+ digits unless a suffix is attached.
      if (m[1].length < 2 && m[2] === undefined && m[3] === undefined) return null;
      return {
        id: `AN${m[1]}`,
        searchTerm: `AN${m[1]}`,
        suffix: m[2] ?? m[3] ?? null,
        suffixStyle: m[2] ? 'dash' : m[3] ? 'code' : null,
      };
    },
  },
  // AS568-214, AS22759/11-22-9: SAE Aerospace Standards.
  {
    family: 'AS',
    re: new RegExp(`${LB}AS(\\d{3,5})(?:\\/(\\d{1,3}[A-Z]?))?${TAIL}${RB}`, 'g'),
    build: (m) => {
      const id = `AS${m[1]}${m[2] ? `/${m[2]}` : ''}`;
      return { id, searchTerm: id, suffix: m[3] ?? null, suffixStyle: m[3] ? 'dash' : null };
    },
  },
  // AMS7276, AMS 5643, AMS5643N.
  {
    family: 'AMS',
    re: new RegExp(`${LB}AMS[ -]?(\\d{4})([A-Z])?${RB}`, 'g'),
    build: (m) => ({ id: `AMS${m[1]}`, searchTerm: `AMS${m[1]}`, revision: m[2] ?? null }),
  },
  // SAE J429, SAE-J1926.
  {
    family: 'SAE-J',
    re: new RegExp(`${LB}SAE[ -]?J[ -]?(\\d{2,4})([A-Z])?${RB}`, 'g'),
    build: (m) => ({ id: `SAE J${m[1]}`, searchTerm: `J${m[1]}`, revision: m[2] ?? null }),
  },
  // ASTM B209-10, ASTM A276, ASTM-F593, ASTM A582M.
  {
    family: 'ASTM',
    re: new RegExp(`${LB}ASTM[ -]?([A-G])[ -]?(\\d{1,4})(M)?(?:-(\\d{2}(?:E\\d)?))?${RB}`, 'g'),
    build: (m) => ({ id: `ASTM ${m[1]}${m[2]}${m[3] ?? ''}`, searchTerm: `${m[1]}${m[2]}`, revision: m[4] ?? null }),
  },
  // ASME B18.2.1, ANSI/ASME B18.3, ANSI B18.2.
  {
    family: 'ASME',
    re: new RegExp(`${LB}(?:ANSI\\/)?(?:ASME|ANSI)[ -]?([BY]\\d{1,3}(?:\\.\\d{1,3}){0,3})([A-Z])?(?:-(\\d{4}))?${RB}`, 'g'),
    build: (m) => ({ id: `ASME ${m[1]}`, searchTerm: m[1], revision: m[3] ?? null }),
  },
  // ISO 4762, ISO 898-1.
  {
    family: 'ISO',
    re: new RegExp(`${LB}ISO[ -]?(\\d{3,6})(?:-(\\d{1,2}))?${RB}`, 'g'),
    build: (m) => ({ id: `ISO ${m[1]}${m[2] ? `-${m[2]}` : ''}`, searchTerm: `ISO ${m[1]}`, revision: null }),
  },
];

const ACCESS: Record<StdFamily, [StdAccess, StdPublisher | null]> = {
  MS: ['assist', null],
  AN: ['assist', null],
  'MIL-STD': ['assist', null],
  'MIL-HDBK': ['assist', null],
  'MIL-DTL': ['assist', null],
  'MIL-PRF': ['assist', null],
  MIL: ['assist', null],
  DOD: ['assist', null],
  FED: ['assist', null],
  CID: ['assist', null],
  'M-SHEET': ['assist', null],
  ADOPTED: ['adopted', 'SAE'],
  NAS: ['sold', 'AIA'],
  NASM: ['sold', 'AIA'],
  AS: ['sold', 'SAE'],
  AMS: ['sold', 'SAE'],
  'SAE-J': ['sold', 'SAE'],
  ASTM: ['sold', 'ASTM'],
  ASME: ['sold', 'ASME'],
  ISO: ['sold', 'ISO'],
};

/** Upper-cases, turns dash look-alikes and non-breaking spaces into plain ones, collapses whitespace. */
export function normaliseRefText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[ \t\r\n_]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * FLIS "MATERIAL DOCUMENT AND CLASSIFICATION" replies lose their first letters in the public file ("-IL-S-25043" for
 * MIL-S-25043, "AST- B209-10" for ASTM B209-10). Repair only those two shapes and only when the reply names the kind of
 * document ("MIL SPEC", "ASSN STD"); anything else is left alone.
 */
function repairTruncated(t: string): { text: string; repaired: boolean } {
  let out = t;
  let repaired = false;
  if (/\bMIL SPEC\b/.test(out)) {
    const next = out.replace(/(?<![A-Z0-9])-IL-(?=[A-Z0-9]{1,4}-\d)/g, 'MIL-');
    if (next !== out) { out = next; repaired = true; }
  }
  if (/\bASSN STD\b/.test(out)) {
    const next = out.replace(/(?<![A-Z0-9])AST- ?(?=[A-G]\d{1,4})/g, 'ASTM ');
    if (next !== out) { out = next; repaired = true; }
  }
  return { text: out, repaired };
}

/**
 * Every standard or specification number found in free text (a characteristics reply, a note), in order of appearance,
 * de-duplicated by id. Overlapping matches keep the earliest, longest one, so "SAE-AMS-P-83461" is one document and
 * "AMS-QQ-A-250/4" is not also an "A-A-250".
 */
export function extractStandardRefs(text: string): StandardRef[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const { text: t, repaired } = repairTruncated(normaliseRefText(text));
  const hits: { start: number; end: number; ref: StandardRef }[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(t)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; }
      const part = rule.build(m);
      if (!part) continue;
      const family = part.family ?? rule.family;
      const [access, publisher] = ACCESS[family];
      const base = blank(family, part.access ?? access, part.publisher !== undefined ? part.publisher : publisher, part.id ?? m[0]);
      hits.push({ start: m.index, end: m.index + m[0].length, ref: { ...base, ...part, family, what: part.what ?? WHAT[family] } });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof hits = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue; // overlaps an earlier, longer match
    kept.push(h);
    lastEnd = h.end;
  }
  const seen = new Set<string>();
  const out: StandardRef[] = [];
  for (const h of kept) {
    if (seen.has(h.ref.id)) continue;
    seen.add(h.ref.id);
    out.push(repaired && /^(MIL|ASTM)/.test(h.ref.id) ? { ...h.ref, inferred: true } : h.ref);
  }
  return out;
}

/**
 * The standard a part number IS, or null. The whole number must be the standard: 'MS35338-44' is MS35338 with dash
 * number 44; 'MS35338-44 BOLT' or a manufacturer's own number is not. Under the government standards CAGEs
 * (STANDARD_CAGES) a catalog 'M' number such as M23053/5-101 is also read as a military specification sheet.
 * `govCage` says whether the CAGE is one of those, which is what lets the page say "this part number is dash number N".
 */
export function standardFromPartNumber(partNumber: string, cage: string | null | undefined): { ref: StandardRef; govCage: boolean } | null {
  if (typeof partNumber !== 'string') return null;
  const pn = normaliseRefText(partNumber).replace(/ /g, '');
  if (pn === '') return null;
  const govCage = typeof cage === 'string' && STANDARD_CAGES.has(cage.trim());

  if (govCage && cage!.trim() === '81349') {
    const m = /^M(\d{4,6})\/(\d{1,3})(?:-([0-9A-Z]{1,8}))?$/.exec(pn);
    if (m) {
      const id = `M${m[1]}/${m[2]}`;
      return {
        govCage,
        ref: {
          ...blank('M-SHEET', 'assist', null, id),
          searchTerm: `${m[1]}/${m[2]}`,
          suffix: m[3] ?? null,
          suffixStyle: m[3] ? 'dash' : null,
        },
      };
    }
  }

  const refs = extractStandardRefs(pn);
  if (refs.length !== 1) return null;
  // The match must cover the whole part number: re-run the rules against it and check the span.
  const ref = refs[0];
  const t = normaliseRefText(pn);
  const rebuilt = ref.suffix ? `${ref.id}${ref.suffixStyle === 'dash' ? '-' : ''}${ref.suffix}` : ref.id;
  const compact = (s: string) => s.replace(/[ -]/g, '');
  const withRev = ref.revision ? compact(`${ref.id}${ref.revision}`) : null;
  const covers =
    compact(t) === compact(rebuilt) ||
    (withRev !== null && compact(t) === withRev) ||
    (ref.inferred && compact(t) === compact(`${ref.id}${ref.suffix ?? ''}`));
  if (!covers) return null;
  return { ref, govCage };
}

/** The link target for a document ASSIST lists; null for industry standards sold by their publisher. */
export function assistUrl(ref: Pick<StandardRef, 'access'>): string | null {
  return ref.access === 'sold' ? null : ASSIST_QUICK_SEARCH_URL;
}

/** Link text: 'Open in ASSIST', 'Open adoption notice in ASSIST', or 'Sold by SAE'. */
export function standardActionLabel(ref: Pick<StandardRef, 'access' | 'publisher'>): string {
  if (ref.access === 'assist') return 'Open in ASSIST';
  if (ref.access === 'adopted') return 'Open adoption notice in ASSIST';
  return ref.publisher ? `Sold by ${PUBLISHER_SHORT[ref.publisher]}` : 'Sold by its publisher';
}

/** One plain sentence about the document: where to get it and what it costs, without legal claims. */
export function standardAvailability(ref: Pick<StandardRef, 'access' | 'publisher'>): string {
  if (ref.access === 'assist') return 'A government document, listed in ASSIST Quick Search, DoD\'s public document search.';
  if (ref.access === 'adopted') {
    return `DoD adopted this industry document. ASSIST lists the adoption notice; the full document is sold by ${ref.publisher ? PUBLISHER_NAME[ref.publisher] : 'its publisher'}.`;
  }
  return `An industry standard. It is bought from ${ref.publisher ? PUBLISHER_NAME[ref.publisher] : 'its publisher'}; we do not link a copy.`;
}

/**
 * One plain sentence for a part whose own part number is a sheet with a dash number (or an attached code), or null.
 * Only for sheet-type families, and only when the sheet's suffix is known.
 */
export function suffixSentence(doc: Pick<StandardRef, 'id' | 'family'>, pn: { suffix: string | null; suffixStyle: 'dash' | 'code' | null }): string | null {
  if (!pn.suffix || !pn.suffixStyle) return null;
  const sheetFamilies: StdFamily[] = ['MS', 'AN', 'NAS', 'NASM', 'AS', 'M-SHEET'];
  if (!sheetFamilies.includes(doc.family)) return null;
  if (pn.suffixStyle === 'dash') {
    return `This part number is dash number ${pn.suffix} of ${doc.id}. The table on that sheet gives the dimensions for dash number ${pn.suffix}.`;
  }
  return `This part number ends in ${pn.suffix}, a variant code on ${doc.id}. The table and notes on that sheet explain the code and give the dimensions.`;
}

export interface StandardDocsInput {
  /** Rows of pub.nsns.characteristics already parsed ({requirement, reply}); entries without a reply are skipped. */
  characteristics: { requirement?: string | null; reply?: string | null }[];
  partNumbers: { partNumber: string; cage: string | null }[];
}

/** Cap on documents shown for one part. */
export const MAX_STANDARD_DOCS = 8;

/**
 * Standard documents for one part: part-number sheets first (they define the part itself), then documents cited in
 * characteristics replies. De-duplicated by id; a document found both ways lists both sources and every part number.
 */
export function collectStandardDocs(input: StandardDocsInput): StandardDoc[] {
  const byId = new Map<string, StandardDoc>();
  const add = (ref: StandardRef, source: StandardDoc['sources'][number]): StandardDoc => {
    let d = byId.get(ref.id);
    if (!d) {
      d = { ...ref, sources: [], partNumbers: [] };
      byId.set(ref.id, d);
    }
    if (!d.sources.includes(source)) d.sources.push(source);
    return d;
  };
  for (const pn of input.partNumbers) {
    const s = standardFromPartNumber(pn.partNumber, pn.cage);
    if (!s) continue;
    const d = add({ ...s.ref, suffix: null, suffixStyle: null }, 'part_number');
    if (!d.partNumbers.some((p) => p.partNumber === pn.partNumber)) {
      d.partNumbers.push({ partNumber: pn.partNumber, suffix: s.ref.suffix, suffixStyle: s.ref.suffixStyle, govCage: s.govCage });
    }
  }
  for (const c of input.characteristics) {
    if (typeof c.reply !== 'string') continue;
    for (const ref of extractStandardRefs(c.reply)) add({ ...ref, suffix: null, suffixStyle: null }, 'characteristic');
  }
  return [...byId.values()].slice(0, MAX_STANDARD_DOCS);
}

/** True when at least one document is a government document or an adoption notice ASSIST lists. */
export const hasAssistDoc = (docs: Pick<StandardRef, 'access'>[]): boolean => docs.some((d) => d.access !== 'sold');
