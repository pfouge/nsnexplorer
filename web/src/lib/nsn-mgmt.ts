// PUB LOG management data for one NSN (pub.nsn_management, migration 0020): the record shapes the single-statement
// loader returns under `flis.management`, the pure mapper from its jsonb column, and the presentation helpers the NSN
// page, the markdown twin and the bid calculator share. No I/O and no database imports (this file is bundled for the
// Workers runtime and unit-tested directly), and it imports sibling modules WITH their .ts extension only.
import { humanizeLabel, moeKind } from './flis-codes.ts';

/** Shown next to a code whose meaning is not in pub.flis_codes or the tables below. */
export const NO_MEANING = 'meaning not on file';

// ---------------------------------------------------------------------------------------------
// Shelf life codes. Source: DoD Manual 4140.27, Volume 1 (DoD Shelf-Life Management Program: Program), July 6, 2016,
// Change 2 December 11, 2019, Section 6 "Shelf-Life Code Assignment", Table 1 "Shelf-Life Codes":
// https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodm/414027_vol1.PDF  (read 2026-11-15; the same
// letter-to-months pairings appear in the Navy NAVSUP copy of Table 1 at
// https://www.navsup.navy.mil/portals/65/Products-Services/HAZMAT/Documents/DoDM_4140.27_Table_1_Shelf_Life_Codes_06.pdf).
// Type I codes are letters and cannot be extended; Type II codes are digits (and X) and can be extended.
// Code 0 means the NSN is not a shelf-life item. Any other code is shown bare.

export const SHELF_LIFE_SOURCE_URL = 'https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodm/414027_vol1.PDF';
export const SHELF_LIFE_SOURCE_LABEL = 'DoD Manual 4140.27, Volume 1, Table 1 (shelf-life codes)';

/** Type I (letter) code -> shelf-life period in months. V is a non-standard period set by the item manager. */
export const SHELF_LIFE_TYPE_I: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 9, H: 12, J: 15, K: 18, L: 21, M: 24, N: 27, P: 30, Q: 36,
  R: 48, S: 60, I: 72, T: 84, U: 96, W: 120, Y: 180, Z: 240,
};
/** Type II (digit) code -> shelf-life period in months. X is a non-standard period set by the item manager. */
export const SHELF_LIFE_TYPE_II: Readonly<Record<string, number>> = { 1: 3, 2: 6, 3: 9, 4: 12, 5: 18, 6: 24, 7: 36, 8: 48, 9: 60 };

export interface ShelfLife {
  code: string;
  /** Plain-words period, e.g. '12 months (1 year)'; null when the code is not in the table. */
  text: string | null;
  /** 'I' cannot be extended, 'II' can be extended, null for 0 / unknown. */
  type: 'I' | 'II' | null;
  /** True for code 0: not a shelf-life item. */
  none: boolean;
}

const monthsText = (m: number): string => {
  const base = `${m} ${m === 1 ? 'month' : 'months'}`;
  if (m >= 12 && m % 12 === 0) return `${base} (${m / 12} ${m === 12 ? 'year' : 'years'})`;
  return base;
};

/** Plain-language reading of a shelf-life code, or {text: null} when the code is not in the DoD table. */
export function shelfLife(code: string | null | undefined): ShelfLife | null {
  const c = (code ?? '').trim().toUpperCase();
  if (c === '') return null;
  if (c === '0') return { code: c, text: 'Not a shelf-life item', type: null, none: true };
  if (c === 'V') return { code: c, text: 'A period set for this item by its manager', type: 'I', none: false };
  if (c === 'X') return { code: c, text: 'A period set for this item by its manager', type: 'II', none: false };
  if (SHELF_LIFE_TYPE_I[c] !== undefined) return { code: c, text: monthsText(SHELF_LIFE_TYPE_I[c]), type: 'I', none: false };
  if (SHELF_LIFE_TYPE_II[c] !== undefined) return { code: c, text: monthsText(SHELF_LIFE_TYPE_II[c]), type: 'II', none: false };
  return { code: c, text: null, type: null, none: false };
}

export interface ShelfLifeParts {
  /** '12 months (1 year)', 'Not a shelf-life item', or the bare code when the code is unknown. */
  headline: string;
  /** 'Cannot be extended' / 'Can be extended', the dictionary label or 'meaning not on file' for an unknown code; null for code 0. */
  note: string | null;
}

/** Headline and note for a shelf-life code; unknown codes use the dictionary label, else the bare code with no meaning. Null when empty. */
export function shelfLifeParts(code: string | null | undefined, dictionaryLabel: string | null = null): ShelfLifeParts | null {
  const s = shelfLife(code);
  if (!s) return null;
  if (s.text === null) return { headline: s.code, note: dictionaryLabel ?? NO_MEANING };
  if (s.none) return { headline: s.text, note: null };
  return { headline: s.text, note: s.type === 'I' ? 'Cannot be extended' : s.type === 'II' ? 'Can be extended' : null };
}

/** One line: '12 months (1 year), cannot be extended'; null when the code is empty. */
export function shelfLifeLine(code: string | null | undefined, dictionaryLabel: string | null = null): string | null {
  const p = shelfLifeParts(code, dictionaryLabel);
  if (!p) return null;
  const known = shelfLife(code)?.text !== null;
  if (!known) return dictionaryLabel ? `${p.headline}: ${dictionaryLabel}` : `${p.headline} (${NO_MEANING})`;
  return p.note ? `${p.headline}, ${p.note.toLowerCase()}` : p.headline;
}

// ---------------------------------------------------------------------------------------------
// Record shapes

export interface MgmtRow {
  /** 'FLIS' for V_FLIS_MANAGEMENT.CSV, else the service file ('ARMY', 'NAVY', 'AIR_FORCE', ...). */
  source: string;
  /** Display name of the scope: the MOE label when the row carries a MOE code, else the source's name. */
  scope: string;
  moeCode: string | null;
  /** 'us' | 'foreign' | 'other'; rows without a MOE code are 'us' (they come from US files). */
  kind: 'us' | 'foreign' | 'other';
  /** ISO date. */
  effectiveDate: string | null;
  aac: string | null;
  aacLabel: string | null;
  sos: string | null;
  sosLabel: string | null;
  ui: string | null;
  uiLabel: string | null;
  /** Dollars as published; 0 and null both mean no price on file. */
  unitPrice: number | null;
  qup: string | null;
  ciic: string | null;
  ciicLabel: string | null;
  slc: string | null;
  slcLabel: string | null;
  repairability: string | null;
}

export interface NsnMgmt {
  rows: MgmtRow[];
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const day = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : s.slice(0, 10);
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const label = (v: unknown): string | null => humanizeLabel(str(v));

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  FLIS: 'Federal catalog (FLIS)',
  ARMY: 'Army',
  NAVY: 'Navy',
  AIR_FORCE: 'Air Force',
  MARINE_CORPS: 'Marine Corps',
  COAST_GUARD: 'Coast Guard',
};

/** 'AIR_FORCE' -> 'Air Force'; known sources have fixed names. */
export function sourceName(source: string): string {
  const s = source.trim().toUpperCase();
  return SOURCE_NAMES[s] ?? humanizeLabel(s.replace(/_/g, ' ')) ?? s;
}

export function mapMgmt(rows: J[] | null | undefined): NsnMgmt {
  const out: MgmtRow[] = (rows ?? []).map((r) => {
    const moeCode = str(r.moe_cd);
    const source = String(r.source ?? '').trim().toUpperCase();
    return {
      source,
      scope: label(r.moe_label) ?? (moeCode && source === 'FLIS' ? moeCode : sourceName(source)),
      moeCode,
      kind: moeCode === null ? 'us' : moeKind(moeCode),
      effectiveDate: day(r.effective_date),
      aac: str(r.aac),
      aacLabel: label(r.aac_label),
      sos: str(r.sos),
      sosLabel: label(r.sos_label),
      ui: str(r.ui),
      uiLabel: label(r.ui_label),
      unitPrice: num(r.unit_price),
      qup: str(r.qup),
      ciic: str(r.ciic),
      ciicLabel: label(r.ciic_label),
      slc: str(r.slc),
      slcLabel: label(r.slc_label),
      repairability: str(r.repairability),
    };
  });
  return { rows: out };
}

// ---------------------------------------------------------------------------------------------
// Presentation

const usd = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
// Same output as shared.ts formatDate (shared.ts is not loadable under node --test).
const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));

export const hasPrice = (r: MgmtRow): boolean => r.unitPrice !== null && r.unitPrice > 0;

export interface StandardPrice {
  /** The single price, or null when services publish different prices. */
  amount: number | null;
  low: number;
  high: number;
  /** Unit of issue the price is per; null when unknown or when the rows disagree. */
  ui: string | null;
  uiLabel: string | null;
  /** ISO date of the record the price comes from; null when the rows disagree or none is dated. */
  effectiveDate: string | null;
  /** True when more than one distinct price is published (low < high). */
  varies: boolean;
}

/**
 * The government standard unit price. Prefers the federal catalog record (source FLIS, no MOE code). Without
 * one, a price that every US row agrees on is the price; otherwise the lowest to highest price is reported
 * with `varies` set and no single amount. Returns null when no US row has a price above zero.
 */
export function standardPrice(m: NsnMgmt): StandardPrice | null {
  const us = m.rows.filter((r) => r.kind === 'us' && hasPrice(r));
  if (us.length === 0) return null;
  const catalog = us.filter((r) => r.source === 'FLIS' && r.moeCode === null);
  const pick = catalog.length > 0 ? catalog : us;
  const prices = [...new Set(pick.map((r) => r.unitPrice as number))].sort((a, b) => a - b);
  const uis = [...new Set(pick.map((r) => r.ui))];
  const dates = [...new Set(pick.map((r) => r.effectiveDate))];
  const first = pick[0];
  return {
    amount: prices.length === 1 ? prices[0] : null,
    low: prices[0],
    high: prices[prices.length - 1],
    ui: uis.length === 1 ? uis[0] : null,
    uiLabel: uis.length === 1 ? first.uiLabel : null,
    effectiveDate: dates.length === 1 ? dates[0] : null,
    varies: prices.length > 1,
  };
}

/** '$20.00 per EA' / '$18.25 to $20.00 depending on the service'. */
export function priceText(p: StandardPrice): string {
  if (p.varies) return `${usd(p.low)} to ${usd(p.high)} depending on the service`;
  return `${usd(p.amount as number)}${p.ui ? ` per ${p.ui}` : ''}`;
}

/** The unit of issue with its meaning when one is on file: 'EA' or 'EA (Each)'. */
export const unitText = (ui: string | null, uiLabel: string | null): string | null => (ui === null ? null : uiLabel && uiLabel.toLowerCase() !== ui.toLowerCase() ? `${ui} (${uiLabel})` : ui);

/** What the unit price is, in plain words (page and markdown twin). */
export const PRICE_EXPLAINER =
  'This is the government’s catalog price for the item, not an award price. It is what a military unit is charged when it orders the item through the supply system, and it includes surcharges, so it is not what a supplier was paid. It is useful as a ceiling sanity check for a quote.';

export interface LastAward {
  price: number;
  /** ISO date. */
  awardedOn: string;
}

/**
 * One line comparing the newest award price with the standard price, e.g.
 * 'Last award $12.40 is 62% of the standard price $20.00.' (from ten times the standard price up: 'is about 15 times the standard price'). Null without a single standard price or a positive award price.
 * When the two are more than a few times apart the line adds a reminder to check the unit of issue.
 */
export function compareToStandard(last: LastAward | null, std: StandardPrice | null): string | null {
  if (!last || !std || std.amount === null || !(last.price > 0) || !(std.amount > 0)) return null;
  const ratio = last.price / std.amount;
  const far = ratio < 0.1 || ratio > 3;
  const tail = far ? ' The two are far apart, so check that both are for the same unit of issue.' : '';
  if (ratio >= 10) return `Last award ${usd(last.price)} is about ${Math.round(ratio).toLocaleString('en-US')} times the standard price ${usd(std.amount)}.${tail}`;
  const pct = ratio < 0.005 ? '<1%' : `${Math.round(ratio * 100)}%`;
  return `Last award ${usd(last.price)} is ${pct} of the standard price ${usd(std.amount)}.${tail}`;
}

export interface MgmtTableRow {
  scope: string;
  price: string;
  ui: string;
  shelfLife: string;
  sos: string;
  aac: string;
  effective: string;
}

export interface MgmtView {
  /** True when there is anything to show. */
  has: boolean;
  price: StandardPrice | null;
  priceLine: string | null;
  effectiveLine: string | null;
  /** Plain-words shelf life when every row agrees; null when none or when they differ (see shelfMixed). */
  shelfLifeLine: string | null;
  /** The same as headline + note for the page's stat cell. */
  shelfParts: ShelfLifeParts | null;
  shelfMixed: boolean;
  /** Source of supply when every row agrees, as 'S9C' or 'S9C (Name)'. */
  sosLine: string | null;
  /** The same split: code and its meaning (null when none on file). */
  sosParts: { code: string; meaning: string | null } | null;
  sosMixed: boolean;
  /** Per-service rows, only when two or more US rows exist and any shown field differs between them. */
  table: MgmtTableRow[];
  /** Rows left out because their MOE code is a foreign government or another organization. */
  hiddenNonUs: number;
  /** The one-line award comparison, when there is a single standard price and a last award. */
  compare: string | null;
}

const dash = '—';

/** Everything the page needs, from the loader rows. `lastAward` is the newest positive award price on the page, if any. */
export function mgmtView(m: NsnMgmt, lastAward: LastAward | null = null): MgmtView {
  const us = m.rows.filter((r) => r.kind === 'us');
  const hiddenNonUs = m.rows.length - us.length;
  const price = standardPrice(m);

  const slcCodes = [...new Set(us.map((r) => r.slc).filter((c): c is string => c !== null).map((c) => c.toUpperCase()))];
  const slcLabelOf = (code: string): string | null => us.find((r) => r.slc?.toUpperCase() === code)?.slcLabel ?? null;
  const shelfMixed = slcCodes.length > 1;
  const shelfLine = slcCodes.length === 1 ? shelfLifeLine(slcCodes[0], slcLabelOf(slcCodes[0])) : null;

  const sosCodes = [...new Set(us.map((r) => r.sos).filter((c): c is string => c !== null))];
  const sosMixed = sosCodes.length > 1;
  const sosLabelOf = (code: string): string | null => us.find((r) => r.sos === code)?.sosLabel ?? null;
  const sosLine = sosCodes.length === 1 ? (sosLabelOf(sosCodes[0]) ? `${sosCodes[0]} (${sosLabelOf(sosCodes[0])})` : sosCodes[0]) : null;

  const shelfParts = slcCodes.length === 1 ? shelfLifeParts(slcCodes[0], slcLabelOf(slcCodes[0])) : null;
  const sosParts = sosCodes.length === 1 ? { code: sosCodes[0], meaning: sosLabelOf(sosCodes[0]) } : null;

  const rows: MgmtTableRow[] = us.map((r) => ({
    scope: r.scope,
    price: hasPrice(r) ? usd(r.unitPrice as number) : dash,
    ui: unitText(r.ui, r.uiLabel) ?? dash,
    shelfLife: r.slc ? (shelfLifeLine(r.slc, r.slcLabel) ?? dash) : dash,
    sos: r.sos ? (r.sosLabel ? `${r.sos} (${r.sosLabel})` : r.sos) : dash,
    aac: r.aac ? (r.aacLabel ? `${r.aac} (${r.aacLabel})` : `${r.aac} (${NO_MEANING})`) : dash,
    effective: r.effectiveDate ? formatDate(r.effectiveDate) : dash,
  }));
  const differ = rows.length >= 2 && rows.some((r) => (['price', 'ui', 'shelfLife', 'sos', 'aac'] as const).some((k) => r[k] !== rows[0][k]));

  const anyShown = price !== null || shelfLine !== null || shelfMixed || sosLine !== null || sosMixed;
  return {
    has: anyShown,
    price,
    priceLine: price ? priceText(price) : null,
    effectiveLine: price?.effectiveDate ? formatDate(price.effectiveDate) : null,
    shelfLifeLine: shelfLine,
    shelfParts,
    shelfMixed,
    sosLine,
    sosParts,
    sosMixed,
    table: differ ? rows : [],
    hiddenNonUs,
    compare: compareToStandard(lastAward, price),
  };
}

/** The reference line for the bid calculator ('Government standard price $20.00 per EA'), or null without a single standard price. */
export function calculatorReference(m: NsnMgmt): { amount: number; text: string } | null {
  const p = standardPrice(m);
  if (!p || p.amount === null) return null;
  return { amount: p.amount, text: `${usd(p.amount)}${p.ui ? ` per ${p.ui}` : ''}` };
}
