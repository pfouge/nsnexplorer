// diagram-more.ts — round 3 drawing families, read by resolveShape() in diagram-shapes.ts.
//
//   shoulder   shoulder screw and shoulder bolt (FSC 5305, 5306): head, ground shoulder, threaded end
//   extnut     self-locking / plain nut with an extended washer (FSC 5310): end view and side view
//   qrpin      quick-release pin (FSC 5315): shank at the stated grip length, head not to scale (schematic)
//   cotter     cotter pin (FSC 5315): two prongs at the stated underloop length (schematic)
//   elbow      tube / pipe elbow (FSC 4730): two legs with the sizes stated for each end (schematic)
//   straight   straight adapter and tube / pipe coupling (FSC 4730): body with the sizes stated for each end (schematic)
//   hoseclamp  hose clamp (FSC 4730, 5340): ring at the stated inside diameter and band width (schematic)
//
// Same rules as diagram-shapes.ts: exact requirement names, null when an essential dimension is missing,
// nothing invented, the catalog's own number text on the dimension. A drawing that is not to scale says
// "SCHEMATIC, NOT TO SCALE" on the sheet.

import type { CharacteristicEntry } from './shared.ts';
import {
  type Meas,
  type Unit,
  BODY_BOTTOM,
  THUMB_STROKE,
  dimH,
  dimV,
  frame,
  getMeas,
  leader,
  ln,
  materialLabel,
  n,
  parseMeasure,
  sharedUnit,
  textWidth,
  thumbCircle,
  thumbWrap,
  txt,
} from './diagram-kit.ts';

export interface MoreOpts {
  nsnDashed: string;
  itemName: string | null;
}
export interface MoreShape {
  kind: string;
  draw(o: MoreOpts): string | null;
  thumb(): string | null;
}
export interface MoreResolved {
  claimed: boolean;
  shape: MoreShape | null;
}

const upper = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
const rootOf = (name: string | null | undefined) => upper(name).split(',')[0].trim();
const tokensOf = (name: string | null | undefined) => upper(name).split(/[,\s/]+/).filter(Boolean);
const SCHEMATIC = 'SCHEMATIC, NOT TO SCALE';

/** One value that a requirement states once, tied to a named feature ("FIRST SHOULDER INCHES ..."): accepted when it is the only entry. */
function featureMeas(entries: CharacteristicEntry[], name: RegExp, allowed: RegExp): Meas | null {
  const hits = entries.filter((e) => e.requirement && name.test(e.requirement));
  if (hits.length !== 1) return null;
  const m = parseMeasure(hits[0].reply);
  if (!m) return null;
  if (m.qualifier !== null && !allowed.test(m.qualifier)) return null;
  return { ...m, qualifier: null };
}

type End = 'FIRST' | 'SECOND';
/** A value stated per end: "FIRST END INCHES 1.562", "SECOND END ...", "ALL ENDS ...". */
function perEnd(entries: CharacteristicEntry[], name: RegExp): { first: Meas | null; second: Meas | null } {
  const found: Record<End, Meas | null> = { FIRST: null, SECOND: null };
  const bad: Record<End, boolean> = { FIRST: false, SECOND: false };
  for (const e of entries) {
    if (!e.requirement || !name.test(e.requirement)) continue;
    const m = parseMeasure(e.reply);
    const q = m?.qualifier ?? null;
    const targets: End[] = q === 'FIRST END' ? ['FIRST'] : q === 'SECOND END' ? ['SECOND'] : q === 'ALL ENDS' ? ['FIRST', 'SECOND'] : [];
    if (!m || targets.length === 0) {
      bad.FIRST = true;
      bad.SECOND = true;
      continue;
    }
    for (const t of targets) {
      if (found[t] && found[t]?.text !== m.text) bad[t] = true;
      found[t] = { ...m, qualifier: null };
    }
  }
  return { first: bad.FIRST ? null : found.FIRST, second: bad.SECOND ? null : found.SECOND };
}

// ---------------------------------------------------------------------------------------------
// Shoulder screw / shoulder bolt
// ---------------------------------------------------------------------------------------------
interface ShoulderModel {
  unit: Unit;
  sDia: Meas;
  sLen: Meas;
  tDia: Meas;
  tLen: Meas;
  headDia: Meas | null;
  headAcross: Meas | null;
  headH: Meas | null;
  total: Meas | null;
  material: string | null;
  isBolt: boolean;
}

function shoulderKind(fsc: string, itemName: string | null): 'screw' | 'bolt' | null {
  if (fsc !== '5305' && fsc !== '5306') return null;
  const root = rootOf(itemName);
  const rest = tokensOf(itemName).slice(1);
  if ((root === 'SCREW' || root === 'BOLT') && rest.length === 1 && rest[0] === 'SHOULDER') return root === 'BOLT' ? 'bolt' : 'screw';
  return null;
}

function shoulderModel(entries: CharacteristicEntry[], isBolt: boolean): ShoulderModel | null {
  const FIRST = /^FIRST SHOULDER$/;
  const sDia = featureMeas(entries, /^SHOULDER DIAMETER$/i, FIRST);
  const sLen = featureMeas(entries, /^SHOULDER LENGTH$/i, FIRST);
  const tDia = getMeas(entries, [/^NOMINAL THREAD DIAMETER$/i]);
  const tLen = getMeas(entries, [/^THREAD LENGTH$/i]);
  if (!sDia || !sLen || !tDia || !tLen) return null;
  const headDia = getMeas(entries, [/^HEAD DIAMETER$/i]);
  const headAcross = getMeas(entries, [/^WIDTH (?:BETWEEN|ACROSS) FLATS$/i]);
  const headH = getMeas(entries, [/^HEAD HEIGHT$/i]);
  const total = getMeas(entries, [/^FASTENER LENGTH$/i]);
  const unit = sharedUnit(sDia, sLen, tDia, tLen, headDia ?? undefined, headAcross ?? undefined, headH ?? undefined, total ?? undefined);
  if (!unit) return null;
  if (!(tDia.mid <= sDia.mid * 1.001)) return null;
  // a stated fastener length must equal shoulder plus thread (it is the length under the head)
  let tot = total;
  if (tot && Math.abs(tot.mid - (sLen.mid + tLen.mid)) > 0.12 * tot.mid) tot = null;
  const head = headDia ?? headAcross;
  if (head && !(head.mid >= sDia.mid)) return null;
  return { unit, sDia, sLen, tDia, tLen, headDia, headAcross, headH, total: tot, material: materialLabel(entries), isBolt };
}

function drawShoulder(m: ShoulderModel, o: MoreOpts): string | null {
  const head = m.headDia ?? m.headAcross;
  const headHalf = head ? head.mid / 2 : m.sDia.mid * 0.75;
  const headAx = m.headH ? m.headH.mid : m.sDia.mid * 0.5;
  const L = headAx + m.sLen.mid + m.tLen.mid;
  const sc = Math.min(430 / L, 130 / (2 * headHalf));
  const px = (v: number) => v * sc;
  const x0 = 380 - px(L) / 2;
  const cy = 205;
  const xs = x0 + px(headAx);
  const xt = xs + px(m.sLen.mid);
  const xe = xt + px(m.tLen.mid);
  const hh = px(headHalf);
  const sh = Math.max(2, px(m.sDia.mid / 2));
  const th = Math.max(1.5, px(m.tDia.mid / 2));
  if (!(px(m.sLen.mid) >= 6) || !(px(m.tLen.mid) >= 6) || !(px(headAx) >= 4)) return null;
  const body = `
    ${txt(380, 48, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - hh)}" width="${n(px(headAx))}" height="${n(2 * hh)}" class="dg-edge"/>
    <rect x="${n(xs)}" y="${n(cy - sh)}" width="${n(px(m.sLen.mid))}" height="${n(2 * sh)}" class="dg-edge"/>
    <rect x="${n(xt)}" y="${n(cy - th)}" width="${n(px(m.tLen.mid))}" height="${n(2 * th)}" class="dg-thread"/>
    ${ln(x0 - 16, cy, xe + 16, cy, 'dg-center')}`;
  const headLabel = m.headDia ? `⌀${m.headDia.text}` : m.headAcross ? `${m.headAcross.text} A/F` : null;
  let dims = '';
  if (headLabel) dims += dimV(cy - hh, cy + hh, x0 - 30, x0, x0, headLabel, 'left');
  dims += dimV(cy - th, cy + th, xe + 30, xe, xe, `⌀${m.tDia.text} THREAD`, 'right');
  dims += leader(xs + px(m.sLen.mid) / 2, cy - sh, Math.max(x0 + 170, xs + 30), cy - hh - 62, 'SHOULDER DIA', `⌀${m.sDia.text}`);
  const rowY = cy + hh + 34;
  dims += dimH(xs, xt, rowY, cy + sh, cy + sh, `${m.sLen.text} SHOULDER LG`, 'below');
  dims += dimH(xt, xe, rowY + 40, cy + th, cy + th, `${m.tLen.text} THREAD LG`, 'below');
  if (m.headH) dims += dimH(x0, xs, cy - hh - 22, cy - hh, cy - hh, `${m.headH.text} HEAD H`, 'above', 'start', x0 - 4);
  if (m.total) dims += dimH(xs, xe, rowY + 80, cy + sh, cy + sh, `${m.total.text} UNDER HEAD LG`, 'below');
  if (rowY + 80 + 24 > BODY_BOTTOM || x0 - 30 - 9 - textWidth(headLabel ?? '') < 20 || xe + 30 + 9 + textWidth(`⌀${m.tDia.text} THREAD`) > 742) return null;
  const unknown: string[] = [];
  if (!head) unknown.push('HEAD SIZE');
  if (!m.headH) unknown.push('HEAD HEIGHT');
  return frame(body + dims, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? (m.isBolt ? 'BOLT, SHOULDER' : 'SCREW, SHOULDER'), m.material],
    notes: ['DRIVE AND THREAD FORM NOT DRAWN', unknown.length ? `NOT STATED: ${unknown.join(', ')}. SHOWN GENERIC` : null],
  });
}

function thumbShoulder(m: ShoulderModel): string | null {
  const head = m.headDia ?? m.headAcross;
  const headHalf = head ? head.mid / 2 : m.sDia.mid * 0.75;
  const headAx = m.headH ? m.headH.mid : m.sDia.mid * 0.5;
  const L = headAx + m.sLen.mid + m.tLen.mid;
  const sc = Math.min(100 / L, 64 / (2 * headHalf));
  const x0 = 60 - (L * sc) / 2;
  const r = (v: number, lo: number) => Math.max(lo, v * sc);
  const xs = x0 + r(headAx, 4);
  const xt = xs + r(m.sLen.mid, 6);
  const hh = r(headHalf, 6);
  const sh = r(m.sDia.mid / 2, 3);
  const th = r(m.tDia.mid / 2, 2);
  return thumbWrap(`<path d="M${n(x0)} ${n(60 - hh)}H${n(xs)}V${n(60 - sh)}H${n(xt)}V${n(60 - th)}H${n(xt + r(m.tLen.mid, 6))}V${n(60 + th)}H${n(xt)}V${n(60 + sh)}H${n(xs)}V${n(60 + hh)}H${n(x0)}Z" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Nut with an extended washer
// ---------------------------------------------------------------------------------------------
interface ExtNutModel {
  unit: Unit;
  thread: Meas;
  height: Meas;
  washerOd: Meas;
  washerThk: Meas | null;
  across: Meas | null;
  material: string | null;
}

function extNutKind(fsc: string, itemName: string | null): boolean {
  if (fsc !== '5310' || rootOf(itemName) !== 'NUT') return false;
  const t = upper(itemName);
  return /\bEXTENDED WASHER\b/.test(t) && !/\b(BLIND RIVET|PLATE|BARREL|CLINCH|WING|CAP)\b/.test(t);
}

function extNutModel(entries: CharacteristicEntry[]): ExtNutModel | null {
  const thread = getMeas(entries, [/^NOMINAL THREAD SIZE$/i]);
  const height = getMeas(entries, [/^OVERALL HEIGHT$/i]);
  const washerOd = getMeas(entries, [/^WASHER OUTSIDE DIAMETER$/i]);
  if (!thread || !height || !washerOd) return null;
  const washerThk = getMeas(entries, [/^WASHER THICKNESS$/i]);
  const across = getMeas(entries, [/^WIDTH ACROSS FLATS$/i]);
  const unit = sharedUnit(thread, height, washerOd, washerThk ?? undefined, across ?? undefined);
  if (!unit) return null;
  if (!(washerOd.mid > thread.mid * 1.2)) return null;
  if (across && !(across.mid > thread.mid && across.mid <= washerOd.mid * 1.05)) return null;
  if (washerThk && !(washerThk.mid < height.mid)) return null;
  return { unit, thread, height, washerOd, washerThk, across, material: materialLabel(entries) };
}

function drawExtNut(m: ExtNutModel, o: MoreOpts): string | null {
  const sc = Math.min(150 / m.washerOd.mid, 190 / m.height.mid);
  const R = (m.washerOd.mid / 2) * sc;
  const A = m.across ? (m.across.mid / 2) * sc : R * 0.8;
  const tPx = Math.max(3, (m.washerThk ? m.washerThk.mid : m.height.mid * 0.2) * sc);
  const hPx = m.height.mid * sc;
  if (!(hPx > tPx + 4) || !(R > 20)) return null;
  const cx = 190;
  const cy = 215;
  const circ = A / Math.cos(Math.PI / 6);
  const hex = [0, 60, 120, 180, 240, 300].map((d) => `${n(cx + circ * Math.cos((d * Math.PI) / 180))},${n(cy + circ * Math.sin((d * Math.PI) / 180))}`).join(' ');
  const bore = Math.max(2, (m.thread.mid / 2) * sc);
  const end = `
    ${txt(cx, 62, 'END VIEW', 'dg-label')}
    <circle cx="${cx}" cy="${cy}" r="${n(R)}" class="dg-edge"/>
    ${m.across ? `<polygon points="${hex}" class="dg-edge"/>` : ''}
    <circle cx="${cx}" cy="${cy}" r="${n(bore)}" class="dg-edge"/>
    ${ln(cx - R - 14, cy, cx + R + 14, cy, 'dg-center')}${ln(cx, cy - R - 14, cx, cy + R + 14, 'dg-center')}
    ${leader(cx + R * 0.7, cy - R * 0.7, 270, cy - R - 26, 'WASHER OUTSIDE DIA', `⌀${m.washerOd.text}`)}
    ${leader(cx + bore * 0.7, cy + bore * 0.7, 270, cy + R + 28, 'THREAD SIZE', `⌀${m.thread.text}`)}`;
  const x0 = 430;
  const side = `
    ${txt(x0 + hPx / 2, 62, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - R)}" width="${n(tPx)}" height="${n(2 * R)}" class="dg-edge"/>
    <rect x="${n(x0 + tPx)}" y="${n(cy - A)}" width="${n(hPx - tPx)}" height="${n(2 * A)}" class="dg-edge"/>
    ${ln(x0 - 14, cy, x0 + hPx + 14, cy, 'dg-center')}
    ${dimH(x0, x0 + hPx, cy + R + 26, cy + R, cy + A, `${m.height.text} OVERALL H`, 'below')}
    ${m.washerThk ? dimH(x0, x0 + tPx, cy - R - 26, cy - R, cy - R, `${m.washerThk.text} WASHER THK`, 'above', 'start', x0 - 2) : ''}
    ${m.across ? dimV(cy - A, cy + A, x0 + hPx + 30, x0 + hPx, x0 + hPx, `${m.across.text} A/F`, 'right') : ''}`;
  if (x0 + hPx + 30 + 9 + textWidth(m.across ? `${m.across.text} A/F` : '') > 742) return null;
  const unknown: string[] = [];
  if (!m.across) unknown.push('WIDTH ACROSS FLATS');
  if (!m.washerThk) unknown.push('WASHER THICKNESS');
  return frame(end + side, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'NUT, EXTENDED WASHER', m.material],
    notes: ['LOCKING ELEMENT AND THREAD NOT DRAWN', unknown.length ? `NOT STATED: ${unknown.join(', ')}. SHOWN GENERIC` : null],
  });
}

function thumbExtNut(m: ExtNutModel): string | null {
  const sc = Math.min(40 / m.washerOd.mid, 60 / m.height.mid);
  const R = (m.washerOd.mid / 2) * sc;
  const A = m.across ? (m.across.mid / 2) * sc : R * 0.8;
  const h = m.height.mid * sc;
  const t = Math.max(3, (m.washerThk ? m.washerThk.mid : m.height.mid * 0.2) * sc);
  const x0 = 60 - h / 2;
  return thumbWrap(`<rect x="${n(x0)}" y="${n(60 - R)}" width="${n(t)}" height="${n(2 * R)}" ${THUMB_STROKE}/><rect x="${n(x0 + t)}" y="${n(60 - A)}" width="${n(Math.max(3, h - t))}" height="${n(2 * A)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Quick-release pin and cotter pin (schematics)
// ---------------------------------------------------------------------------------------------
interface PinMore {
  variant: 'quick-release' | 'cotter';
  unit: Unit;
  dia: Meas;
  len: Meas;
  headDia: Meas | null;
  material: string | null;
}

function pinMoreKind(fsc: string, itemName: string | null): 'quick-release' | 'cotter' | null {
  if (fsc !== '5315' || rootOf(itemName) !== 'PIN') return null;
  const rest = tokensOf(itemName).slice(1);
  if (rest.length === 2 && rest[0] === 'QUICK' && rest[1] === 'RELEASE') return 'quick-release';
  if (rest.length === 1 && rest[0] === 'COTTER') return 'cotter';
  return null;
}

function pinMoreModel(entries: CharacteristicEntry[], variant: 'quick-release' | 'cotter'): PinMore | null {
  const dia = variant === 'cotter' ? getMeas(entries, [/^DIAMETER$/i]) : getMeas(entries, [/^SHANK DIAMETER$/i]);
  const len = variant === 'cotter' ? getMeas(entries, [/^UNDERLOOP LENGTH$/i]) : getMeas(entries, [/^GRIP LENGTH$/i]);
  if (!dia || !len) return null;
  const headDia = variant === 'quick-release' ? getMeas(entries, [/^HEAD DIAMETER$/i]) : null;
  const unit = sharedUnit(dia, len, headDia ?? undefined);
  if (!unit) return null;
  if (!(len.mid > dia.mid)) return null;
  if (headDia && !(headDia.mid > dia.mid)) return null;
  return { variant, unit, dia, len, headDia, material: materialLabel(entries) };
}

function drawPinMore(m: PinMore, o: MoreOpts): string | null {
  const cotter = m.variant === 'cotter';
  const sc = Math.min(240 / m.len.mid, 120 / (m.headDia ? m.headDia.mid : m.dia.mid * 2.5));
  const d = Math.max(4, m.dia.mid * sc);
  const Lpx = m.len.mid * sc;
  const cy = 215;
  const x0 = Math.max(225, 340 - Lpx / 2);
  let shape: string;
  let dims: string;
  if (cotter) {
    const eyeR = d * 0.7;
    const xs = x0 + eyeR * 2;
    shape = `
      <circle cx="${n(x0 + eyeR)}" cy="${n(cy)}" r="${n(eyeR)}" class="dg-edge"/>
      <rect x="${n(xs)}" y="${n(cy - d / 2)}" width="${n(Lpx)}" height="${n(d / 2)}" class="dg-edge"/>
      <rect x="${n(xs)}" y="${n(cy)}" width="${n(Lpx)}" height="${n(d / 2)}" class="dg-edge"/>`;
    dims = dimH(xs, xs + Lpx, cy + d / 2 + 34, cy + d / 2, cy + d / 2, `${m.len.text} UNDERLOOP LG`, 'below') +
      dimV(cy - d / 2, cy + d / 2, xs + Lpx + 34, xs + Lpx, xs + Lpx, `⌀${m.dia.text}`, 'right');
    if (xs + Lpx + 34 + 9 + textWidth(`⌀${m.dia.text}`) > 742) return null;
  } else {
    const hd = m.headDia ? m.headDia.mid * sc : d * 2.2;
    const hAx = Math.max(10, d * 0.9);
    const xs = x0 + hAx;
    shape = `
      <rect x="${n(x0)}" y="${n(cy - hd / 2)}" width="${n(hAx)}" height="${n(hd)}" class="dg-edge"/>
      <rect x="${n(xs)}" y="${n(cy - d / 2)}" width="${n(Lpx)}" height="${n(d)}" class="dg-edge"/>
      ${ln(x0 - 14, cy, xs + Lpx + 14, cy, 'dg-center')}`;
    dims = dimH(xs, xs + Lpx, cy + Math.max(hd, d) / 2 + 34, cy + d / 2, cy + d / 2, `${m.len.text} GRIP LG`, 'below') +
      dimV(cy - d / 2, cy + d / 2, xs + Lpx + 34, xs + Lpx, xs + Lpx, `⌀${m.dia.text} SHANK`, 'right') +
      (m.headDia ? dimV(cy - hd / 2, cy + hd / 2, x0 - 30, x0, x0, `⌀${m.headDia.text} HEAD`, 'left') : '');
    if (xs + Lpx + 34 + 9 + textWidth(`⌀${m.dia.text} SHANK`) > 742 || x0 - 30 - 9 - textWidth(m.headDia ? `⌀${m.headDia.text} HEAD` : '') < 20) return null;
  }
  return frame(`${txt(380, 62, SCHEMATIC, 'dg-label')}${shape}${dims}`, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? (cotter ? 'PIN, COTTER' : 'PIN, QUICK RELEASE'), m.material],
    notes: [cotter ? 'LOOP SHAPE AND PRONG ENDS NOT TO SCALE' : 'HEAD, HANDLE, DETENT AND TIP NOT DRAWN OR NOT TO SCALE', 'LENGTH AND DIAMETER ARE AS STATED'],
  });
}

function thumbPinMore(m: PinMore): string | null {
  const sc = Math.min(80 / m.len.mid, 30 / m.dia.mid);
  const d = Math.max(4, m.dia.mid * sc);
  const L = m.len.mid * sc;
  const x0 = 60 - L / 2;
  if (m.variant === 'cotter') {
    return thumbWrap(`<circle cx="${n(x0 - 4)}" cy="60" r="${n(Math.max(3, d * 0.7))}" ${THUMB_STROKE}/><rect x="${n(x0)}" y="${n(60 - d / 2)}" width="${n(L)}" height="${n(d)}" ${THUMB_STROKE}/>`);
  }
  const hd = Math.max(d * 2, 12);
  return thumbWrap(`<rect x="${n(x0 - 8)}" y="${n(60 - hd / 2)}" width="8" height="${n(hd)}" ${THUMB_STROKE}/><rect x="${n(x0)}" y="${n(60 - d / 2)}" width="${n(L)}" height="${n(d)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Tube / pipe fittings (schematics)
// ---------------------------------------------------------------------------------------------
interface EndInfo {
  leg: Meas | null;
  labels: string[];
}
interface FittingModel {
  variant: 'elbow' | 'straight';
  unit: Unit;
  ends: [EndInfo, EndInfo];
  overall: Meas | null;
  angle: number | null;
  material: string | null;
}

function fittingKind(fsc: string, itemName: string | null): 'elbow' | 'straight' | null {
  if (fsc !== '4730') return null;
  const root = rootOf(itemName);
  const rest = tokensOf(itemName).slice(1);
  if (root === 'ELBOW') return 'elbow';
  if (root === 'ADAPTER' && rest[0] === 'STRAIGHT') return 'straight';
  if (root === 'COUPLING' && rest.length === 1 && (rest[0] === 'TUBE' || rest[0] === 'PIPE')) return 'straight';
  return null;
}

const END_SIZES: { name: RegExp; label: string; dia: boolean }[] = [
  { name: /^NOMINAL THREAD SIZE$/i, label: 'THREAD', dia: true },
  { name: /^NOMINAL OUTSIDE DIAMETER TUBE ACCOMMODATED$/i, label: 'TUBE OD', dia: true },
  { name: /^NOMINAL PIPE SIZE ACCOMMODATED$/i, label: 'PIPE', dia: false },
  { name: /^NOMINAL INSIDE DIAMETER HOSE ACCOMMODATED$/i, label: 'HOSE ID', dia: true },
];

function fittingModel(entries: CharacteristicEntry[], variant: 'elbow' | 'straight'): FittingModel | null {
  const legs = variant === 'elbow' ? perEnd(entries, /^LEG LENGTH$/i) : { first: null, second: null };
  const overall = variant === 'straight' ? getMeas(entries, [/^NOMINAL OVERALL LENGTH$/i, /^OVERALL LENGTH$/i]) : null;
  if (variant === 'elbow' && !legs.first && !legs.second) return null;
  if (variant === 'straight' && !overall) return null;
  const ends: [EndInfo, EndInfo] = [
    { leg: legs.first, labels: [] },
    { leg: legs.second, labels: [] },
  ];
  const ms: Meas[] = [];
  for (const s of END_SIZES) {
    const pe = perEnd(entries, s.name);
    [pe.first, pe.second].forEach((mm, i) => {
      if (!mm) return;
      ms.push(mm);
      ends[i].labels.push(`${s.label} ${s.dia ? '⌀' : ''}${mm.text}`);
    });
  }
  if (legs.first) ms.push(legs.first);
  if (legs.second) ms.push(legs.second);
  if (overall) ms.push(overall);
  if (ends[0].labels.length + ends[1].labels.length === 0) return null;
  const unit = sharedUnit(...ms);
  if (!unit) return null;
  let angle: number | null = null;
  // degrees are not a length unit, so the angle is read from the reply text
  const angHit = entries.filter((e) => e.requirement && /^FLOW ANGLE$/i.test(e.requirement));
  if (angHit.length === 1) {
    const mt = /^\s*DEGREES\s+(?:NOMINAL\s+)?(\d+(?:\.\d+)?)\s*$/i.exec(angHit[0].reply ?? '');
    if (mt && Number(mt[1]) > 10 && Number(mt[1]) <= 150) angle = Number(mt[1]);
  }
  return { variant, unit, ends, overall, angle, material: materialLabel(entries) };
}

function endLabels(txtX: number, y: number, labels: string[], anchor: 'start' | 'end' | 'middle'): string {
  return labels.slice(0, 3).map((t, i) => txt(txtX, y + i * 16, t, 'dg-dim', anchor)).join('');
}

function drawFitting(m: FittingModel, o: MoreOpts): string | null {
  const w = 22; // tube drawn width (not to scale)
  let body = txt(380, 56, SCHEMATIC, 'dg-label');
  let angleNote: string | null = null;
  if (m.variant === 'elbow') {
    const ang = m.angle ?? 90;
    if (m.angle === null) angleNote = 'FLOW ANGLE NOT STATED, SHOWN AS 90 DEGREES';
    const a = (ang * Math.PI) / 180;
    const L = 150;
    // legs meet at the bend point; the flow comes in along leg 1 and turns by the flow angle
    const bx = 330;
    const by = 190;
    const x1 = bx - L;
    const y1 = by;
    const x2 = bx + L * Math.cos(a);
    const y2 = by + L * Math.sin(a);
    const dx = x2 - bx;
    const dy = y2 - by;
    const len = Math.hypot(dx, dy);
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    body += `
      <rect x="${n(x1)}" y="${n(by - w / 2)}" width="${n(L)}" height="${w}" class="dg-edge"/>
      <polygon points="${n(bx + nx)},${n(by + ny)} ${n(x2 + nx)},${n(y2 + ny)} ${n(x2 - nx)},${n(y2 - ny)} ${n(bx - nx)},${n(by - ny)}" class="dg-edge"/>
      <circle cx="${n(bx)}" cy="${n(by)}" r="${w / 2}" class="dg-edge"/>`;
    if (!(x2 > 120 && x2 < 700 && y2 > 90 && y2 < 400)) return null;
    body += endLabels(x1 - 14, by - 6, m.ends[0].labels, 'end');
    body += m.ends[0].leg ? txt((x1 + bx) / 2, by - w / 2 - 14, `${m.ends[0].leg.text} LEG LG`, 'dg-dim', 'middle') : '';
    const right = x2 >= bx;
    body += endLabels(right ? x2 + 14 : x2 - 14, y2 + 4, m.ends[1].labels, right ? 'start' : 'end');
    body += m.ends[1].leg ? txt((bx + x2) / 2 + (right ? 26 : -26), (by + y2) / 2 - 12, `${m.ends[1].leg.text} LEG LG`, 'dg-dim', right ? 'start' : 'end') : '';
    if (x1 - 14 - Math.max(...m.ends[0].labels.map((t) => textWidth(t)), 0) < 20) return null;
  } else {
    const x0 = 200;
    const x1 = 560;
    const cy = 200;
    body += `
      <rect x="${x0}" y="${cy - w / 2}" width="${x1 - x0}" height="${w}" class="dg-edge"/>
      <rect x="${(x0 + x1) / 2 - 36}" y="${cy - w / 2 - 8}" width="72" height="${w + 16}" class="dg-edge"/>
      ${ln(x0 - 14, cy, x1 + 14, cy, 'dg-center')}
      ${dimH(x0, x1, cy + w / 2 + 40, cy + w / 2, cy + w / 2, `${(m.overall as Meas).text} OVERALL LG`, 'below')}`;
    body += endLabels(x0 - 14, cy - 6, m.ends[0].labels, 'end');
    body += endLabels(x1 + 14, cy - 6, m.ends[1].labels, 'start');
    if (x0 - 14 - Math.max(...m.ends[0].labels.map((t) => textWidth(t)), 0) < 20 || x1 + 14 + Math.max(...m.ends[1].labels.map((t) => textWidth(t)), 0) > 742) return null;
  }
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'FITTING', m.material],
    notes: [m.variant === 'elbow' && m.angle !== null ? `FLOW TURNS ${m.angle} DEGREES AS STATED` : 'SIZES ARE THE CATALOG VALUES FOR EACH END', m.ends.some((e) => e.labels.length === 0) ? 'AN END WITH NO SIZE STATED IS LEFT UNLABELLED' : null, angleNote],
  });
}

function thumbFitting(m: FittingModel): string | null {
  if (m.variant === 'elbow') {
    const ang = ((m.angle ?? 90) * Math.PI) / 180;
    const x2 = 70 + 40 * Math.cos(ang);
    const y2 = 50 + 40 * Math.sin(ang);
    return thumbWrap(`<polyline points="22,50 70,50 ${n(x2)},${n(y2)}" fill="none" stroke="var(--ink)" stroke-width="9" stroke-linejoin="round"/>`);
  }
  return thumbWrap(`<rect x="14" y="52" width="92" height="16" ${THUMB_STROKE}/><rect x="46" y="46" width="28" height="28" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Hose clamp (schematic)
// ---------------------------------------------------------------------------------------------
interface HoseClampModel {
  unit: Unit;
  id: Meas;
  width: Meas;
  material: string | null;
}

function hoseClampKind(fsc: string, itemName: string | null): boolean {
  if (fsc !== '4730' && fsc !== '5340') return false;
  const rest = tokensOf(itemName).slice(1);
  return rootOf(itemName) === 'CLAMP' && rest.length === 1 && rest[0] === 'HOSE';
}

function hoseClampModel(entries: CharacteristicEntry[]): HoseClampModel | null {
  const id = getMeas(entries, [/^INSIDE DIAMETER$/i]);
  const width = getMeas(entries, [/^OVERALL WIDTH$/i]);
  if (!id || !width) return null;
  const unit = sharedUnit(id, width);
  if (!unit) return null;
  if (!(width.mid < id.mid * 3)) return null;
  return { unit, id, width, material: materialLabel(entries) };
}

function drawHoseClamp(m: HoseClampModel, o: MoreOpts): string | null {
  const sc = Math.min(170 / m.id.mid, 330 / m.width.mid);
  const R = (m.id.mid / 2) * sc;
  const wPx = Math.max(6, m.width.mid * sc);
  const band = Math.max(3, Math.min(10, R * 0.08));
  const cx = 210;
  const cy = 220;
  const x0 = 430;
  const body = `${txt(380, 56, SCHEMATIC, 'dg-label')}
    ${txt(cx, 84, 'END VIEW', 'dg-label')}
    <circle cx="${cx}" cy="${cy}" r="${n(R)}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${n(R + band)}" class="dg-edge"/>
    ${ln(cx - R - band - 14, cy, cx + R + band + 14, cy, 'dg-center')}${ln(cx, cy - R - band - 14, cx, cy + R + band + 14, 'dg-center')}
    ${leader(cx + R * 0.7, cy + R * 0.7, 270, cy + R + 38, 'INSIDE DIA', `⌀${m.id.text}`)}
    ${txt(x0 + wPx / 2, 84, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - R - band)}" width="${n(wPx)}" height="${n(2 * (R + band))}" class="dg-edge"/>
    ${dimH(x0, x0 + wPx, cy + R + band + 30, cy + R + band, cy + R + band, `${m.width.text} WIDE`, 'below', 'start', x0 - 2)}`;
  if (x0 + wPx > 735) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'CLAMP, HOSE', m.material],
    notes: ['BAND THICKNESS, SCREW HOUSING AND TAIL NOT DRAWN', 'DIAMETER AND WIDTH ARE AS STATED'],
  });
}

function thumbHoseClamp(m: HoseClampModel): string | null {
  const R = m.id.mid > 0 ? 30 : 30;
  return thumbWrap(`${thumbCircle(60, 60, R)}${thumbCircle(60, 60, R + 5)}`);
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------
export function resolveMore(entries: CharacteristicEntry[], fsc: string, itemName: string | null): MoreResolved | null {
  const sk = shoulderKind(fsc, itemName);
  if (sk) {
    const m = shoulderModel(entries, sk === 'bolt');
    return { claimed: true, shape: m ? { kind: 'shoulder', draw: (o) => drawShoulder(m, o), thumb: () => thumbShoulder(m) } : null };
  }
  if (extNutKind(fsc, itemName)) {
    const m = extNutModel(entries);
    return { claimed: true, shape: m ? { kind: 'extnut', draw: (o) => drawExtNut(m, o), thumb: () => thumbExtNut(m) } : null };
  }
  const pk = pinMoreKind(fsc, itemName);
  if (pk) {
    const m = pinMoreModel(entries, pk);
    return { claimed: true, shape: m ? { kind: pk === 'cotter' ? 'cotter' : 'qrpin', draw: (o) => drawPinMore(m, o), thumb: () => thumbPinMore(m) } : null };
  }
  const fk = fittingKind(fsc, itemName);
  if (fk) {
    const m = fittingModel(entries, fk);
    return { claimed: true, shape: m ? { kind: fk, draw: (o) => drawFitting(m, o), thumb: () => thumbFitting(m) } : null };
  }
  if (hoseClampKind(fsc, itemName)) {
    const m = hoseClampModel(entries);
    return { claimed: true, shape: m ? { kind: 'hoseclamp', draw: (o) => drawHoseClamp(m, o), thumb: () => thumbHoseClamp(m) } : null };
  }
  return null;
}

export const moreKinds = { shoulderKind, extNutKind, pinMoreKind, fittingKind, hoseClampKind };
