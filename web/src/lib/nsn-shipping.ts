// PUB LOG freight and packaging data for one NSN (pub.nsn_packaging and pub.nsn_freight, migration 0023): the record
// shapes the single-statement loader returns under `flis.shipping`, the pure mapper from its two jsonb columns, the
// code-decoding rule, and the view model the NSN page and the markdown twin share. No I/O and no database imports
// (this file is bundled for the Workers runtime and unit-tested directly); sibling modules are imported WITH their
// .ts extension only.
import { cleanDefinition, humanizeLabel } from './flis-codes.ts';

export const SHIPPING_TITLE = 'Shipping and packaging';
export const SHIPPING_GLOSS = 'Packaging and freight data the federal catalog (DLA FLIS) holds for this NSN.';
export const SHIPPING_UNITS_NOTE = 'Weights are in pounds, sizes in inches and cube in cubic feet by DoD packaging convention. The source files do not state units.';
export const SHIPPING_SOURCE = 'Source: the DLA PUB LOG freight and packaging files (FREIGHT_PACKAGING).';
export const HMC_NONE = 'None on file';

// ---------------------------------------------------------------------------------------------
// Code decoding

/** One code from the PUB LOG code dictionary (pub.flis_codes, key '<FIELD>:<value>') with its plain-word meaning. */
export interface DecodedCode {
  /** Source column name in upper case, e.g. 'MOP'. */
  field: string;
  /** The code as published (for PKG_CAT the whole 4-character code). */
  code: string;
  /** For PKG_CAT only: the part of the code the dictionary key was built from (the first two characters). */
  decodedPart: string | null;
  /** Dictionary literal and description exactly as stored (null when the dictionary has no row). */
  literal: string | null;
  description: string | null;
  /** Plain words; null when the dictionary has no row or no usable text. Never invented. */
  meaning: string | null;
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};
/** A positive finite number; the migration stores 0 ("not recorded") as NULL, and 0 or less is treated as absent here too. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A literal that only says "this is a number" or "these character positions": the description carries the meaning. */
export const PLACEHOLDER_LITERAL = /^(NUMERIC|POSITIONS?\b)/i;

/** First sentence of the cleaned dictionary description, capped like cleanDefinition, without its final period. */
function firstSentence(description: string | null): string | null {
  const cleaned = cleanDefinition(description, 600);
  if (cleaned === null) return null;
  const m = cleaned.match(/^.*?[.!?](?=\s+[A-Z(]|$)/);
  const capped = cleanDefinition(m ? m[0] : cleaned, 140);
  return capped === null ? null : capped.replace(/\.$/, '');
}

/**
 * The plain-word meaning of a code from its dictionary row: the humanized literal, unless the literal is a
 * placeholder (NUMERIC, POSITION 4, ...), in which case the first sentence of the cleaned description. Null when
 * there is no usable text.
 */
export function decodeMeaning(literal: string | null | undefined, description: string | null | undefined): string | null {
  const lit = str(literal);
  if (lit !== null && !PLACEHOLDER_LITERAL.test(lit)) return humanizeLabel(lit);
  return firstSentence(str(description));
}

/** Number text without trailing zeros: 85 -> '85', 92.5 -> '92.5', 0.0070 -> '0.007'. At most `max` decimals. */
export function formatNumber(n: number, max = 4): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: max, useGrouping: true }).format(n);
}

/** LTL literals that are numbers ('85.0') read as 'Class 85'; the rest ('RATING VARIABLE', 'NO RATING') are humanized. */
export function ltlMeaning(literal: string | null | undefined, description: string | null | undefined): string | null {
  const lit = str(literal);
  if (lit !== null && /^\d+(\.\d+)?$/.test(lit)) return `Class ${formatNumber(Number(lit))}`;
  return decodeMeaning(literal, description);
}

/**
 * Builds the decoded code for one column. `def` is the dictionary row ({literal, description}) the loader found, or
 * null/undefined when there is none (then the code stands alone with no meaning). `part` is the part of the code the
 * dictionary key was built from, when it is not the whole code (PKG_CAT).
 */
export function decodeCode(field: string, code: unknown, def: J | null | undefined, opts: { part?: string } = {}): DecodedCode | null {
  const c = str(code);
  if (c === null) return null;
  const literal = def ? str(def.literal) : null;
  const description = def ? str(def.description) : null;
  const meaning = !def ? null : field === 'LTL' ? ltlMeaning(literal, description) : decodeMeaning(literal, description);
  return { field, code: c, decodedPart: opts.part ?? null, literal, description, meaning };
}

/** '<meaning> (code Q)' or, with no meaning on file, 'Code Q'. */
export function codeText(d: DecodedCode): string {
  return d.meaning ? `${d.meaning} (code ${d.code})` : `Code ${d.code}`;
}

// ---------------------------------------------------------------------------------------------
// Record shapes

export interface PackagingRow {
  /** 'P' (primary inventory control activity), 'S' (secondary) or '' when blank. */
  picaSica: string;
  /** Only the first two characters are decoded (the dictionary cannot tell positions 3 and 4 apart). */
  pkgCat: DecodedCode | null;
  unpkgItemWeight: number | null;
  unpkgItemWidth: number | null;
  unpkgItemLength: number | null;
  unpkgItemHeight: number | null;
  mop: DecodedCode | null;
  spcMkg: DecodedCode | null;
  ucl: DecodedCode | null;
  lvlA: DecodedCode | null;
  lvlB: DecodedCode | null;
  lvlC: DecodedCode | null;
  unitPackWeight: number | null;
  /** Breadth is the width. */
  upSzMaxB: number | null;
  upSzMaxL: number | null;
  upSzMaxH: number | null;
  unitPackCube: number | null;
  supplementalInstructions: string | null;
  spiNo: string | null;
  spiRev: string | null;
}

export interface FreightRow {
  nmfc: string | null;
  nmfcSub: string | null;
  nmfDesc: string | null;
  hmc: DecodedCode | null;
  ltl: DecodedCode | null;
  tcc: DecodedCode | null;
  shc: DecodedCode | null;
}

export interface NsnShipping {
  /** Ordered P first, then S, then any other; at most a handful of rows. */
  packaging: PackagingRow[];
  freight: FreightRow | null;
}

export function mapPackaging(rows: J[] | null | undefined): PackagingRow[] {
  return (rows ?? []).map((r) => {
    const cat = str(r.pkg_cat);
    return {
      picaSica: String(r.pica_sica ?? '').trim().toUpperCase(),
      pkgCat: decodeCode('PKG_CAT', cat, r.pkg_cat_def, { part: cat === null ? undefined : cat.slice(0, 2) }),
      unpkgItemWeight: num(r.unpkg_item_weight),
      unpkgItemWidth: num(r.unpkg_item_width),
      unpkgItemLength: num(r.unpkg_item_length),
      unpkgItemHeight: num(r.unpkg_item_height),
      mop: decodeCode('MOP', r.mop, r.mop_def),
      spcMkg: decodeCode('SPC_MKG', r.spc_mkg, r.spc_mkg_def),
      ucl: decodeCode('UCL', r.ucl, r.ucl_def),
      lvlA: decodeCode('LVL_A', r.lvl_a, r.lvl_a_def),
      lvlB: decodeCode('LVL_B', r.lvl_b, r.lvl_b_def),
      lvlC: decodeCode('LVL_C', r.lvl_c, r.lvl_c_def),
      unitPackWeight: num(r.unit_pack_weight),
      upSzMaxB: num(r.up_sz_maxb),
      upSzMaxL: num(r.up_sz_maxl),
      upSzMaxH: num(r.up_sz_maxh),
      unitPackCube: num(r.unit_pack_cube),
      supplementalInstructions: str(r.supplemental_instructions),
      spiNo: str(r.spi_no),
      spiRev: str(r.spi_rev),
    };
  });
}

export function mapFreight(r: J | null | undefined): FreightRow | null {
  if (!r) return null;
  return {
    nmfc: str(r.nmfc),
    nmfcSub: str(r.nmfc_sub),
    nmfDesc: str(r.nmf_desc),
    hmc: decodeCode('HMC', r.hmc, r.hmc_def),
    ltl: decodeCode('LTL', r.ltl, r.ltl_def),
    tcc: decodeCode('TCC', r.tcc, r.tcc_def),
    shc: decodeCode('SHC', r.shc, r.shc_def),
  };
}

export function mapShipping(packaging: J[] | null | undefined, freight: J | null | undefined): NsnShipping {
  return { packaging: mapPackaging(packaging), freight: mapFreight(freight) };
}

// ---------------------------------------------------------------------------------------------
// Presentation

/** The packaging row the page uses: the P (primary) row, else the S (secondary) row, else none. */
export function pickPackaging(rows: PackagingRow[]): PackagingRow | null {
  return rows.find((r) => r.picaSica === 'P') ?? rows.find((r) => r.picaSica === 'S') ?? null;
}

const sizeText = (l: number | null, w: number | null, h: number | null): string | null =>
  l !== null && w !== null && h !== null ? `${formatNumber(l)} x ${formatNumber(w)} x ${formatNumber(h)} in (length x width x height)` : null;

export interface ShippingRowView {
  key: string;
  label: string;
  /** One or more lines of text, in order. */
  lines: string[];
  /** A short plain-language note under the value, or null. */
  note: string | null;
  /** True for rows whose text can be long (the page gives them the full width). */
  wide: boolean;
}

export interface ShippingView {
  /** True when there is at least one row to show; the block is not rendered otherwise. */
  has: boolean;
  /** 'P' or 'S': which packaging row the values come from; null without one. */
  packagingFrom: 'P' | 'S' | null;
  rows: ShippingRowView[];
  /** True when a weight, size or cube row is shown (the units note applies). */
  hasMeasures: boolean;
}

/** Everything the page needs, from the loader rows. */
export function shippingView(s: NsnShipping): ShippingView {
  const rows: ShippingRowView[] = [];
  const add = (key: string, label: string, lines: (string | null)[], opts: { note?: string | null; wide?: boolean } = {}): void => {
    const ls = lines.filter((l): l is string => l !== null);
    if (ls.length > 0) rows.push({ key, label, lines: ls, note: opts.note ?? null, wide: opts.wide ?? false });
  };
  const withUnit = (n: number | null, unit: string): string | null => (n === null ? null : `${formatNumber(n)} ${unit}`);

  const p = pickPackaging(s.packaging);
  if (p) {
    add('unitPackWeight', 'Unit pack weight', [withUnit(p.unitPackWeight, 'lb')]);
    add('unitPackCube', 'Unit pack cube', [withUnit(p.unitPackCube, 'cu ft')]);
    add('unitPackSize', 'Unit pack size', [sizeText(p.upSzMaxL, p.upSzMaxB, p.upSzMaxH)]);
    add('unpkgWeight', 'Unpackaged item weight', [withUnit(p.unpkgItemWeight, 'lb')]);
    add('unpkgSize', 'Unpackaged item size', [sizeText(p.unpkgItemLength, p.unpkgItemWidth, p.unpkgItemHeight)]);
    if (p.pkgCat) {
      const part = p.pkgCat.decodedPart;
      add('pkgCat', 'Packaging category', [codeText(p.pkgCat)], {
        note: p.pkgCat.meaning && part && p.pkgCat.code.length > part.length ? `The meaning is for the first two characters (${part}).` : null,
        wide: true,
      });
    }
    if (p.mop) add('mop', 'Method of preservation', [codeText(p.mop)], { wide: true });
    const lv = (name: string, d: DecodedCode | null): string | null => (d === null ? null : d.meaning ? `${name}: ${d.meaning} (code ${d.code})` : `${name}: code ${d.code}`);
    add('levels', 'Packing level', [lv('Level A', p.lvlA), lv('Level B', p.lvlB), lv('Level C', p.lvlC)], { wide: true });
    if (p.ucl) add('ucl', 'Unit container level', [codeText(p.ucl)], { wide: true });
    if (p.spcMkg) add('spcMkg', 'Special marking', [codeText(p.spcMkg)], { wide: true });
    if (p.spiNo) add('spi', 'Special packaging instruction', [p.spiRev ? `${p.spiNo}, revision ${p.spiRev}` : p.spiNo], { wide: true });
    add('supplemental', 'Supplemental instructions', [p.supplementalInstructions], { wide: true });
  }
  const hasMeasures = rows.some((r) => ['unitPackWeight', 'unitPackCube', 'unitPackSize', 'unpkgWeight', 'unpkgSize'].includes(r.key));

  const f = s.freight;
  if (f) {
    const item = f.nmfc ? `Item ${f.nmfc}${f.nmfcSub ? `, sub ${f.nmfcSub}` : ''}` : null;
    add('nmfc', 'Freight class (NMFC)', [item, f.nmfDesc], { wide: true });
    if (f.ltl) add('ltl', 'LTL class', [codeText(f.ltl)]);
    add('hmc', 'Hazardous material code', [f.hmc ? codeText(f.hmc) : HMC_NONE], { wide: true });
    if (f.tcc) add('tcc', 'Type of cargo', [codeText(f.tcc)], { wide: true });
    if (f.shc) add('shc', 'Special handling', [codeText(f.shc)], { wide: true });
  }

  return { has: rows.length > 0, packagingFrom: p ? (p.picaSica as 'P' | 'S') : null, rows, hasMeasures };
}
