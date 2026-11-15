// diagram-kit.ts — shared parsing and SVG pieces for the newer drawing builders (diagram-shapes.ts).
//
// The first nine builders in diagram.ts each carry their own copy of the helpers. New builders share
// this one set so they read measurements the same strict way and look the same: same classes
// (dg-*), same 760 x 505 sheet, same title block wording, same CSS variables for both themes.
//
// Reading a FLIS reply (public catalog data, written by ingest/publog/load.mjs):
//   "INCHES  NOMINAL  0.7500"                         one value
//   "INCHES  MINIMUM  0.0580 AND INCHES  MAXIMUM  0.0620"   a range
//   "43.85 MILLIMETERS MINIMUM AND 44.95 MILLIMETERS MAXIMUM"   (older rows write the number first)
//   "INCHES  MAXIMUM  0.875"                          a limit, not a nominal size
//   "EXTERNAL  INCHES  0.875"                         a value that belongs to one feature (qualified)
// A qualified reply, a requirement that appears twice with different values, or mixed units are all
// "ambiguous": the helpers return null instead of choosing one, so a builder cannot draw a guess.
//
// Pure string work. No value imports, so node --test can load it without a build step.

import type { CharacteristicEntry } from './shared.ts';

export type Unit = 'IN' | 'MM' | 'CM';
export const UNIT_LONG: Record<Unit, string> = { IN: 'INCHES', MM: 'MILLIMETERS', CM: 'CENTIMETERS' };

export interface Meas {
  kind: 'nominal' | 'range' | 'max' | 'min';
  lo: number;
  hi: number;
  /** The value to draw to scale: the nominal, the middle of a range, or the limit. */
  mid: number;
  unit: Unit;
  /** As printed on the drawing and written in the catalog: "0.7500", "0.5007–0.5013", "0.875 MAX". */
  text: string;
  /** The same number text without a MAX/MIN suffix ("0.7500", "0.5007–0.5013", "0.875"). */
  num: string;
  /** Words around the number that say which feature it belongs to; null when the reply is just the value. */
  qualifier: string | null;
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const UNIT_WORD = '(INCHES|INCH|MILLIMETERS|MILLIMETRES|MILLIMETER|MILLIMETRE|CENTIMETERS|CENTIMETRES|CENTIMETER|CENTIMETRE)';
const QUAL_WORD = '(NOMINAL|MINIMUM|MAXIMUM)';
const NUM = '(\\d+(?:\\.\\d+)?)';
// unit first ("INCHES NOMINAL 0.75") or number first ("43.85 MILLIMETERS MINIMUM").
const TRIPLE = new RegExp(
  `\\b${UNIT_WORD}\\s+(?:${QUAL_WORD}\\s+)?${NUM}\\b|\\b${NUM}\\s+${UNIT_WORD}(?:\\s+${QUAL_WORD})?\\b`,
  'g'
);

const NEUTRAL_QUALIFIER = /^(?:OVERALL )?(?:LOCATION NOT OTHERWISE SPECIFIED|OVERALL|ALL)$/;
const unitFromWord = (w: string): Unit => (w.startsWith('INCH') ? 'IN' : w.startsWith('MILLI') ? 'MM' : 'CM');

/** Strict reading of one reply. null when it is not one length (or one min/max pair) in one unit. */
export function parseMeasure(reply: string | null | undefined): Meas | null {
  if (!reply) return null;
  const s = reply.replace(/\s+/g, ' ').trim().toUpperCase();
  const triples: { unit: Unit; qual: string | null; raw: string; v: number; start: number; end: number }[] = [];
  TRIPLE.lastIndex = 0;
  for (let m = TRIPLE.exec(s); m; m = TRIPLE.exec(s)) {
    // alternative 1 (unit first): groups 1 unit, 2 qualifier, 3 number; alternative 2 (number first): 4 number, 5 unit, 6 qualifier
    const unitWord = m[1] ?? m[5];
    const qual = (m[2] ?? m[6] ?? null) as string | null;
    const raw = m[3] ?? m[4];
    triples.push({ unit: unitFromWord(unitWord), qual, raw, v: Number(raw), start: m.index, end: m.index + m[0].length });
  }
  if (triples.length === 0 || triples.length > 2) return null;
  if (triples.some((t) => !Number.isFinite(t.v) || t.v <= 0)) return null;
  if (triples.length === 2 && triples[0].unit !== triples[1].unit) return null;
  // words outside the matched spans (except the AND that joins a min/max pair)
  let rest = '';
  let at = 0;
  for (const t of triples) {
    rest += ' ' + s.slice(at, t.start);
    at = t.end;
  }
  rest += ' ' + s.slice(at);
  let qualifier: string | null = rest.replace(/\bAND\b/g, ' ').replace(/\s+/g, ' ').trim() || null;
  // "LOCATION NOT OTHERWISE SPECIFIED INCHES 0.500" and "OVERALL INCHES ..." say the value belongs to the whole
  // item, not to one feature, so they read as plain values.
  if (qualifier !== null && NEUTRAL_QUALIFIER.test(qualifier)) qualifier = null;
  const unit = triples[0].unit;
  if (triples.length === 1) {
    const t = triples[0];
    const kind = t.qual === 'MAXIMUM' ? 'max' : t.qual === 'MINIMUM' ? 'min' : 'nominal';
    return {
      kind,
      lo: t.v,
      hi: t.v,
      mid: t.v,
      unit,
      num: t.raw,
      text: kind === 'max' ? `${t.raw} MAX` : kind === 'min' ? `${t.raw} MIN` : t.raw,
      qualifier,
    };
  }
  const [a, b] = triples;
  const lo = a.qual === 'MINIMUM' && b.qual === 'MAXIMUM' ? a : a.qual === 'MAXIMUM' && b.qual === 'MINIMUM' ? b : null;
  const hi = lo === a ? b : a;
  if (!lo || lo.v > hi.v) return null; // two nominals (or a backwards pair) are not one dimension
  const num = lo.v === hi.v ? lo.raw : `${lo.raw}–${hi.raw}`;
  return { kind: 'range', lo: lo.v, hi: hi.v, mid: (lo.v + hi.v) / 2, unit, num, text: num, qualifier };
}

/**
 * One measurement by requirement name. Patterns are tried in order; the first pattern that matches any
 * entry decides (a weaker pattern is never used to rescue a strong one that was unusable). Returns null
 * when the entry is missing, qualified, unparseable, or repeated with different values.
 */
export function getMeas(entries: CharacteristicEntry[], pats: RegExp[]): Meas | null {
  for (const pat of pats) {
    const hits = entries.filter((e) => e.requirement && pat.test(e.requirement));
    if (hits.length === 0) continue;
    const parsed = hits.map((h) => parseMeasure(h.reply));
    if (parsed.some((p) => p === null || p.qualifier !== null)) return null;
    const first = parsed[0] as Meas;
    if (parsed.some((p) => (p as Meas).text !== first.text || (p as Meas).unit !== first.unit)) return null;
    return first;
  }
  return null;
}

/**
 * Like getMeas, but accepts replies that are each tied to a feature ("NUT THREAD INCHES 0.312",
 * "STUD THREAD INCHES 0.312") as long as every reply gives the same number in the same unit. Used for a
 * size that is stated once per end of a double-ended part: when both ends agree the size is not in doubt.
 */
export function getMeasAgreeing(entries: CharacteristicEntry[], pats: RegExp[]): Meas | null {
  for (const pat of pats) {
    const hits = entries.filter((e) => e.requirement && pat.test(e.requirement));
    if (hits.length === 0) continue;
    const parsed = hits.map((h) => parseMeasure(h.reply));
    if (parsed.some((p) => p === null)) return null;
    const first = parsed[0] as Meas;
    if (parsed.some((p) => (p as Meas).text !== first.text || (p as Meas).unit !== first.unit)) return null;
    return { ...first, qualifier: null };
  }
  return null;
}

/** A text reply by requirement name: exactly one distinct non-empty value, else null. */
export function getText(entries: CharacteristicEntry[], pats: RegExp[]): string | null {
  for (const pat of pats) {
    const hits = entries.filter((e) => e.requirement && pat.test(e.requirement));
    if (hits.length === 0) continue;
    const vals = new Set(hits.map((h) => (h.reply ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean));
    return vals.size === 1 ? [...vals][0] : null;
  }
  return null;
}

/** True when any entry's requirement matches (the part has that feature on file, whatever its value). */
export const hasReq = (entries: CharacteristicEntry[], pat: RegExp): boolean =>
  entries.some((e) => e.requirement && pat.test(e.requirement));

/** The one unit shared by every measurement, or null if they disagree. */
export function sharedUnit(...ms: (Meas | null | undefined)[]): Unit | null {
  const present = ms.filter((m): m is Meas => !!m);
  if (present.length === 0) return null;
  return present.every((m) => m.unit === present[0].unit) ? present[0].unit : null;
}

/** A single MATERIAL entry shown in the title block ("OVERALL " dropped); several entries (per component) are skipped. */
export function materialLabel(entries: CharacteristicEntry[]): string | null {
  const hits = entries.filter((e) => e.requirement && /^MATERIAL$/i.test(e.requirement) && e.reply);
  if (hits.length !== 1) return null;
  const t = (hits[0].reply as string).replace(/\s+/g, ' ').trim().replace(/^OVERALL\s+/i, '');
  return t ? clip(t, 44) : null;
}

export function clip(t: string, n: number): string {
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Thread callout from stated values only: "0.190-32 UNJF 3A", "M6", ... Qualified or repeated values are left out. */
export function threadCallout(entries: CharacteristicEntry[]): string | null {
  const size = getMeasAgreeing(entries, [/^(?:NONMACHINE )?NOMINAL THREAD (?:DIAMETER|SIZE)$/i, /^THREAD (?:DIAMETER|SIZE)$/i]);
  if (!size) return null;
  const tpi = getText(entries, [/^THREAD QUANTITY PER INCH$/i]);
  const series = getText(entries, [/^THREAD SERIES DESIGNATOR$/i]);
  const cls = getText(entries, [/^THREAD CLASS$/i]);
  const dir = getText(entries, [/^THREAD DIRECTION$/i]);
  const tpiTxt = tpi && /^\d{1,3}$/.test(tpi) ? `-${tpi}` : '';
  const ser = series ? (series.match(/\(([A-Z0-9-]{2,8})\)/)?.[1] ?? (/^[A-Z0-9-]{2,8}$/.test(series) ? series : null)) : null;
  const parts = [`${size.num}${tpiTxt}`, ser, cls && /^\d[AB]$/i.test(cls) ? cls.toUpperCase() : null, dir && /LEFT/i.test(dir) ? 'LH' : null];
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------------------------
// SVG pieces
// ---------------------------------------------------------------------------------------------

/** Rounds to two decimals and turns NaN / Infinity into 0 (frame() then refuses the whole drawing). */
export const n = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : 'NaN');

export const ln = (x1: number, y1: number, x2: number, y2: number, cls: string): string =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="${cls}"/>`;

export function arrow(x: number, y: number, dir: 'l' | 'r' | 'u' | 'd'): string {
  const d = 7;
  const w = 2.6;
  const p =
    dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
    : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
    : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
    : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
  const pts = p.split(' ').map((pair) => pair.split(',').map(Number)).map(([px, py]) => `${n(px)},${n(py)}`).join(' ');
  return `<polygon points="${pts}" class="dg-fill"/>`;
}

export const txt = (x: number, y: number, t: string, cls: 'dg-dim' | 'dg-note' | 'dg-label' | 'dg-title', anchor: 'start' | 'middle' | 'end' = 'middle'): string =>
  `<text x="${n(x)}" y="${n(y)}" class="${cls}" text-anchor="${anchor}">${esc(t)}</text>`;

/** Rough width of mono text on the sheet, in sheet units (IBM Plex Mono is 0.6 em wide, plus tracking). */
export const FONT_PX = { 'dg-dim': 13, 'dg-note': 10, 'dg-label': 14, 'dg-title': 15 } as const;
export const textWidth = (t: string, cls: keyof typeof FONT_PX = 'dg-dim'): number => {
  const px = FONT_PX[cls];
  const track = cls === 'dg-dim' ? 0 : cls === 'dg-note' ? 0.03 : cls === 'dg-label' ? 0.05 : 0.06;
  return t.length * px * (0.6 + track);
};

/**
 * Horizontal dimension: extension lines from the two feature points (their y is yF1 / yF2), dimension line at
 * yDim, label above or below it. labelX/anchor move the label when the span is shorter than the text.
 */
export function dimH(x1: number, x2: number, yDim: number, yF1: number, yF2: number, label: string, labelSide: 'above' | 'below' = 'above', anchor: 'start' | 'middle' | 'end' = 'middle', labelX?: number): string {
  const dir = yDim < Math.min(yF1, yF2) ? -1 : 1;
  const ext = (x: number, yF: number) => ln(x, yF + dir * 5, x, yDim + dir * 4, 'dg-ext');
  const tx = labelX ?? (x1 + x2) / 2;
  const ty = labelSide === 'above' ? yDim - 8 : yDim + 17;
  return `${ext(x1, yF1)}${ext(x2, yF2)}${ln(x1, yDim, x2, yDim, 'dg-dimline')}${arrow(x1, yDim, 'l')}${arrow(x2, yDim, 'r')}${txt(tx, ty, label, 'dg-dim', anchor)}`;
}

/** Vertical dimension: extension lines from the feature (their x is xF1 / xF2), dimension line at xDim, label to one side. */
export function dimV(y1: number, y2: number, xDim: number, xF1: number, xF2: number, label: string | null, side: 'left' | 'right'): string {
  const dir = xDim < Math.min(xF1, xF2) ? -1 : 1;
  const ext = (y: number, xF: number) => ln(xF + dir * 5, y, xDim + dir * 4, y, 'dg-ext');
  const t = label === null ? '' : side === 'right' ? txt(xDim + 9, (y1 + y2) / 2 + 4, label, 'dg-dim', 'start') : txt(xDim - 9, (y1 + y2) / 2 + 4, label, 'dg-dim', 'end');
  return `${ext(y1, xF1)}${ext(y2, xF2)}${ln(xDim, y1, xDim, y2, 'dg-dimline')}${arrow(xDim, y1, 'u')}${arrow(xDim, y2, 'd')}${t}`;
}

/** Leader from a point on the part to a two-line label (small caption over the value). */
export function leader(px: number, py: number, lx: number, ly: number, caption: string, value: string, anchor: 'start' | 'end' = 'start'): string {
  const toX = anchor === 'start' ? lx - 4 : lx + 4;
  return `${ln(px, py, toX, ly - 4, 'dg-ext')}<circle cx="${n(px)}" cy="${n(py)}" r="1.6" class="dg-fill"/>${txt(lx, ly, caption, 'dg-note', anchor)}${txt(lx, ly + 14, value, 'dg-dim', anchor)}`;
}

export const SHEET_W = 760;
export const SHEET_H = 505;
/** Everything except the title block must stay above this y. */
export const BODY_BOTTOM = 428;
export const TITLE_RULE_Y = 438;

const STYLE = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch-k); }
    .dg-thread { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-thread-k); }
    .dg-hidden { stroke: var(--ink-soft); stroke-width: 1.1; stroke-dasharray: 5 3; }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-cut { stroke: var(--ink); stroke-width: 2.4; stroke-dasharray: 10 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;

const DEFS = `<defs>
    <pattern id="dg-hatch-k" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/>
    </pattern>
    <pattern id="dg-thread-k" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="5" style="stroke:var(--ink);stroke-width:1"/>
    </pattern>
  </defs>`;

export interface FrameOpts {
  nsnDashed: string;
  unit: Unit;
  /** Title block line 2: item name, material, thread, and so on. */
  items: (string | null | undefined)[];
  /** Title block line 3: what the drawing does not show or does not know. */
  notes: (string | null | undefined)[];
}

/**
 * Wraps the drawing body in the sheet: style, hatch patterns, units tag and the title block.
 * Returns null if any coordinate went bad (NaN / Infinity), so a page never shows a broken drawing.
 */
export function frame(body: string, o: FrameOpts): string | null {
  const long = UNIT_LONG[o.unit];
  const items = clip(o.items.filter(Boolean).join('  ·  '), 104);
  const notes = clip(o.notes.filter(Boolean).join('  ·  '), 104);
  const tbY = 458;
  const title = `
    ${ln(28, TITLE_RULE_Y, 732, TITLE_RULE_Y, 'dg-edge')}
    ${txt(28, tbY, o.nsnDashed, 'dg-title', 'start')}
    ${txt(732, tbY, `ALL DIMENSIONS IN ${long} · REFERENCE ONLY, NOT FOR MANUFACTURE`, 'dg-note', 'end')}
    ${items ? txt(28, tbY + 19, items, 'dg-note', 'start') : ''}
    ${notes ? txt(28, tbY + 34, notes, 'dg-note', 'start') : ''}`;
  const svg = `<svg viewBox="0 0 ${SHEET_W} ${SHEET_H}" role="img" aria-label="Dimensioned drawing of ${esc(o.nsnDashed)} (${long})" xmlns="http://www.w3.org/2000/svg">
  ${STYLE}${DEFS}${txt(732, 30, `UNITS: ${long}`, 'dg-note', 'end')}${body}${title}
</svg>`;
  return /NaN|Infinity|undefined/.test(svg) ? null : svg;
}

// Thumbnails (120 x 120, no text), same stroke as the existing silhouettes.
export const THUMB_STROKE = 'stroke="var(--ink)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"';
export const thumbWrap = (body: string): string | null => {
  const svg = `<svg viewBox="0 0 120 120" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  return /NaN|Infinity|undefined/.test(svg) ? null : svg;
};
export const thumbCircle = (cx: number, cy: number, r: number): string =>
  `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(0.5, r))}" ${THUMB_STROKE}/>`;
