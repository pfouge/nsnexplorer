// Pure helpers for the agency page (/agency/<slug>/): federal fiscal years,
// shares and bar widths, and the row shaping the page needs. No I/O and no
// imports, so it runs unchanged at build time and under `node --test`.

/** Federal fiscal year N runs 1 October N-1 to 30 September N. Null for anything that is not YYYY-MM-DD. */
export function fiscalYear(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(isoDate);
  if (!m) return null;
  const year = Number(m[1]);
  return Number(m[2]) >= 10 ? year + 1 : year;
}

/** `part` as a percentage of `total`, rounded to one decimal; null when the total is not positive. */
export function share(part: number, total: number): number | null {
  if (!(total > 0) || !Number.isFinite(part)) return null;
  return Math.round((part / total) * 1000) / 10;
}

/** Share for display: "12.3%", "<0.1%" for a positive sliver, "0.0%" for zero or less, "—" with no total. */
export function formatShare(part: number, total: number): string {
  const s = share(part, total);
  if (s === null) return '—';
  if (s <= 0) return part > 0 ? '<0.1%' : '0.0%';
  return `${s.toFixed(1)}%`;
}

/** Bar width 0..100 (integer). Negative values (de-obligations) and a non-positive max give 0. */
export function barWidth(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

/** USAspending descriptions often start "8512297505!PACKING,PREFORMED": drop a leading digit run plus "!". */
export function cleanDescription(s: string | null | undefined): string {
  return (s ?? '').replace(/^\s*\d+!\s*/, '').trim();
}

/** One-line text cut to `max` characters at a word boundary when possible, ending with an ellipsis. */
export function truncateText(s: string | null | undefined, max = 80): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

export interface FiscalYearRow { fy: number; actions: number; obligated: number }

/** Fills fiscal years with no actions between the first and last so the table has no gaps; ascending order. */
export function fillFiscalYears(rows: FiscalYearRow[]): FiscalYearRow[] {
  if (rows.length === 0) return [];
  const by = new Map(rows.map((r) => [r.fy, r]));
  const lo = Math.min(...by.keys());
  const hi = Math.max(...by.keys());
  const out: FiscalYearRow[] = [];
  for (let fy = lo; fy <= hi; fy++) out.push(by.get(fy) ?? { fy, actions: 0, obligated: 0 });
  return out;
}

/** "FY2019–FY2026", or "FY2026" when they match; null with no years. */
export function fiscalRange(first: string | null, last: string | null): string | null {
  const a = first ? fiscalYear(first) : null;
  const b = last ? fiscalYear(last) : null;
  if (a === null || b === null) return null;
  return a === b ? `FY${a}` : `FY${a}–FY${b}`;
}

const int = (n: number): string => n.toLocaleString('en-US');

/** Compact dollars: $1.2B, $3.4M, $5.6K, $789; keeps the sign. */
export function compactUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const f = (v: number, suffix: string) => `${sign}$${(Math.round(v * 10) / 10).toString()}${suffix}`;
  if (a >= 1e9) return f(a / 1e9, 'B');
  if (a >= 1e6) return f(a / 1e6, 'M');
  if (a >= 1e3) return f(a / 1e3, 'K');
  return `${sign}$${int(Math.round(a))}`;
}

export interface LedeInput {
  actions: number;
  obligated: number;
  recipients: number;
  classes: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** "X contract actions worth $Y to Z suppliers, FY2019–FY2026, from USAspending." */
export function agencyLede(p: LedeInput | undefined): string | null {
  if (!p || p.actions <= 0) return null;
  const range = fiscalRange(p.firstDate, p.lastDate);
  const actions = `${int(p.actions)} contract ${p.actions === 1 ? 'action' : 'actions'}`;
  const sup = `${int(p.recipients)} ${p.recipients === 1 ? 'supplier' : 'suppliers'}`;
  const cls = `${p.classes === 1 ? 'the 1 supply class' : `the ${int(p.classes)} supply classes`} NSN Explorer tracks`;
  return `${actions} worth ${compactUsd(p.obligated)} to ${sup} in ${cls}${range ? `, ${range}` : ''}, from USAspending.`;
}
