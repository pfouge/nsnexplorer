// diagram-shapes.ts — drawing builders added after the first nine in diagram.ts.
//
// Families (each one: a strict model read from the FLIS characteristics, a full drawing, a list thumbnail):
//   fastener   bolt, screw and stud (FSC 5305, 5306, 5307)  and  rivet / pin-rivet (FSC 5320)
//   annulus    ball and roller bearing (3110), plain encased shaft seal and flat ring gasket (5330), round shim (5365)
//   retaining  retaining ring (5325, 5365)
//   loop       loop clamp (5340)
//   key        machine key (5315)
//
// Rules every builder here follows:
//   * Read requirements by exact name through diagram-kit getMeas(): a value that is qualified ("EXTERNAL ..."),
//     repeated with different numbers, or in a different unit from the rest is "ambiguous" and counts as missing.
//   * Return null when an essential dimension is missing. Never invent a dimension.
//   * A feature the catalog does not state (head shape, thread extent, radial width) is drawn in a neutral way
//     and named on the third title-block line ("NOT STATED: ...").
//   * The dimension text is the catalog's own number text ("0.7500", "0.5007–0.5013", "0.875 MAX").
//   * resolveShape() is the one place that decides which family a part belongs to, and the drawing and the list
//     thumbnail both come from the same model, so "has a thumbnail" and "has a drawing" always agree.

import type { CharacteristicEntry } from './shared.ts';
import {
  type Meas,
  type Unit,
  BODY_BOTTOM,
  THUMB_STROKE,
  arrow,
  clip,
  dimH,
  dimV,
  frame,
  getMeas,
  getMeasAgreeing,
  getText,
  hasReq,
  leader,
  ln,
  materialLabel,
  n,
  sharedUnit,
  textWidth,
  thumbCircle,
  thumbWrap,
  threadCallout,
  txt,
} from './diagram-kit.ts';
import { resolveMore } from './diagram-more.ts';

export interface ShapeOpts {
  nsnDashed: string;
  itemName: string | null;
}

export interface Shape {
  kind: string;
  draw(o: ShapeOpts): string | null;
  thumb(): string | null;
}

const upper = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
const rootOf = (name: string | null | undefined) => upper(name).split(',')[0].trim();
const tokensOf = (name: string | null | undefined) => upper(name).split(/[,\s/]+/).filter(Boolean);
const same = (m: Meas | null, unit: Unit): Meas | null => (m && m.unit === unit ? m : null);

// ---------------------------------------------------------------------------------------------
// Fastener family: bolt, screw, stud, rivet, pin-rivet
// ---------------------------------------------------------------------------------------------

export type FastenerKind = 'bolt' | 'screw' | 'stud' | 'rivet' | 'pin';

export interface FastenerModel {
  kind: FastenerKind;
  unit: Unit;
  dia: Meas; // thread diameter (bolt, screw, stud) or shank diameter (rivet)
  len: Meas;
  /** FASTENER LENGTH is measured from the head's bearing surface to the tip; OVERALL LENGTH includes the head. */
  underHead: boolean;
  headDia: Meas | null;
  flats: Meas | null;
  headH: Meas | null;
  threadLen: Meas | null;
  grip: Meas | null;
  headStyle: 'dome' | 'csk' | 'block' | null;
  headStyleText: string | null;
  continuousThread: boolean;
  /** Headless: a stud, a threaded rod or a headless pin. */
  noHead: boolean;
  /** Extra words for the notes line (pin: cross holes and grooves that are not drawn). */
  extraNotes: string[];
  thread: string | null;
  material: string | null;
  name: string;
}

// Names that share the FSC with ordinary fasteners but are not "head block plus straight shank".
const FASTENER_NOT_STRAIGHT = new Set(['EYE', 'HOOK', 'U', 'J', 'L', 'SWING', 'TOGGLE', 'EXPANSION', 'ANCHOR', 'SET', 'SHOULDER', 'SHOULDERED', 'CAPTIVE', 'THUMB', 'WING', 'WELDING', 'WELD', 'DOUBLE', 'STEPPED']);
const STUD_PLAIN = new Set(['PLAIN', 'CONTINUOUS', 'THREAD', 'THREADED', 'END']);
const RIVET_NOT_PLAIN = new Set(['EYELET', 'TUBULAR', 'HOLLOW']);

export function fastenerKindFor(fsc: string, itemName: string | null): FastenerKind | null {
  const root = rootOf(itemName);
  const toks = tokensOf(itemName);
  if (fsc === '5320') {
    if (!(root === 'RIVET' || root === 'PIN-RIVET')) return null;
    if (toks.some((t) => RIVET_NOT_PLAIN.has(t))) return null;
    return 'rivet';
  }
  if (fsc === '5315') return pinKindFor(itemName) ? 'pin' : null;
  if (fsc === '5305' || fsc === '5306' || fsc === '5307') {
    if (toks.slice(1).some((t) => FASTENER_NOT_STRAIGHT.has(t))) return null;
    if (root === 'SETSCREW' || root === 'THUMBSCREW' || root === 'ASSEMBLY') return null;
    if (fsc === '5307' || root === 'STUD' || root === 'ROD') {
      // headless: plain studs and threaded rods only (bonded, locked-in, self-locking, turnlock, ball ... studs are not a bar)
      if (!toks.slice(1).every((t) => STUD_PLAIN.has(t))) return null;
      return 'stud';
    }
    return fsc === '5306' || root === 'BOLT' ? 'bolt' : 'screw';
  }
  return null;
}

export function fastenerModel(entries: CharacteristicEntry[], kind: FastenerKind, itemName: string | null): FastenerModel | null {
  if (kind === 'pin') return pinModel(entries, itemName);
  const dia =
    kind === 'rivet'
      ? getMeas(entries, [/^SHANK DIAMETER$/i, /^NOMINAL (?:SHANK )?DIAMETER$/i, /^BODY DIAMETER$/i])
      : (kind === 'stud' ? getMeasAgreeing : getMeas)(entries, [/^(?:NONMACHINE )?NOMINAL THREAD (?:DIAMETER|SIZE)$/i, /^THREAD (?:DIAMETER|SIZE)$/i, /^NOMINAL DIAMETER$/i, /^SHANK DIAMETER$/i, /^BODY DIAMETER$/i]);
  if (!dia) return null;
  // FASTENER LENGTH is the under-head length. If it is on file but unusable, do not quietly swap in another length.
  let len: Meas | null;
  let underHead = false;
  if (hasReq(entries, /^FASTENER LENGTH$/i)) {
    len = getMeas(entries, [/^FASTENER LENGTH$/i]);
    underHead = true;
  } else {
    len = getMeas(entries, [/^OVERALL LENGTH$/i, /^NOMINAL LENGTH$/i, /^LENGTH$/i]);
  }
  if (!len) return null;
  const unit = dia.unit;
  if (len.unit !== unit) return null;
  const opt = (pats: RegExp[]) => same(getMeas(entries, pats), unit);
  let headDia = opt([/^HEAD MAJOR DIAMETER$/i, /^HEAD DIAMETER$/i]);
  let flats = opt([/^WIDTH (?:ACROSS|BETWEEN) FLATS$/i]);
  const headH = opt([/^HEAD HEIGHT$/i]);
  let threadLen = kind === 'rivet' ? null : same(getMeasAgreeing(entries, [/^THREAD LENGTH$/i]), unit);
  const grip = kind === 'rivet' ? opt([/^GRIP LENGTH$/i]) : null;
  // A head that is not wider than the shank is a bad match for a head diameter: treat it as not stated.
  if (headDia && !(headDia.mid > dia.mid * 1.05)) headDia = null;
  if (flats && !(flats.mid > dia.mid * 1.05)) flats = null;
  if (threadLen && !(threadLen.mid <= len.mid * 1.001)) threadLen = null;
  const styleText = getText(entries, [/^HEAD (?:STYLE|TYPE)$/i]);
  const st = upper(styleText);
  const headStyle: FastenerModel['headStyle'] = !st
    ? null
    : /\b(UNIVERSAL|ROUND|BUTTON|PAN|DOME|OVAL|BINDING|TRUSS|MUSHROOM)\b/.test(st)
      ? 'dome'
      : /\b(FLAT|COUNTERSUNK|FLUSH|CSK)\b|\b(82|90|100)\s*(DEG|DEGREE)/.test(st)
        ? 'csk'
        : /\b(HEX|HEXAGON|HEXAGONAL|SQUARE|SOCKET|FILLISTER|CAP|CYLINDRICAL|STRAIGHT)\b/.test(st)
          ? 'block'
          : null;
  return {
    kind,
    unit,
    dia,
    len,
    underHead,
    headDia,
    flats,
    headH,
    threadLen,
    grip,
    headStyle,
    headStyleText: styleText,
    continuousThread: /\bCONTINUOUS\b/.test(upper(itemName)),
    noHead: kind === 'stud',
    extraNotes: [],
    thread: kind === 'rivet' ? null : threadCallout(entries),
    material: materialLabel(entries),
    name: itemName ?? '',
  };
}


// Straight pins (FSC 5315): headless or headed, with or without grooves. Cotter, quick-release, spring, tapered,
// shoulder, lock and other pins are not a bar with an optional head, so they are not drawn.
const PIN_OK = new Set(['STRAIGHT', 'GROOVED', 'HEADED', 'HEADLESS']);

function pinKindFor(itemName: string | null): boolean {
  if (rootOf(itemName) !== 'PIN') return false;
  const rest = tokensOf(itemName).slice(1);
  if (rest.length === 0) return true;
  return rest.every((t) => PIN_OK.has(t)) && (rest.includes('HEADED') || rest.includes('HEADLESS'));
}

function pinModel(entries: CharacteristicEntry[], itemName: string | null): FastenerModel | null {
  const toks = tokensOf(itemName).slice(1);
  const headed = toks.includes('HEADED');
  const dia = getMeas(entries, [/^DIAMETER$/i, /^PIN OVERALL DIAMETER$/i, /^SHANK DIAMETER$/i]);
  if (!dia) return null;
  let len: Meas | null;
  let underHead = false;
  if (headed && hasReq(entries, /^UNDER HEAD LENGTH$/i)) {
    len = getMeas(entries, [/^UNDER HEAD LENGTH$/i]);
    underHead = true;
  } else {
    len = getMeas(entries, [/^PIN OVERALL LENGTH$/i, /^OVERALL LENGTH$/i, /^LENGTH$/i]);
  }
  if (!len || len.unit !== dia.unit) return null;
  const unit = dia.unit;
  let headDia = headed ? same(getMeas(entries, [/^PIN HEAD DIAMETER$/i]), unit) : null;
  if (headDia && !(headDia.mid > dia.mid * 1.05)) headDia = null;
  const headH = headed ? same(getMeas(entries, [/^HEIGHT$/i]), unit) : null;
  const extra: string[] = [];
  if (hasReq(entries, /^FIRST HOLE DIAMETER$|^DISTANCE FROM CENTERLINE OF HOLE TO END OF PIN$/i)) extra.push('CROSS HOLE');
  if (hasReq(entries, /^CHAMFER LENGTH$/i)) extra.push('CHAMFER');
  if (toks.includes('GROOVED')) extra.push('GROOVES');
  return {
    kind: 'pin',
    unit,
    dia,
    len,
    underHead,
    headDia,
    flats: null,
    headH,
    threadLen: null,
    grip: null,
    headStyle: headed ? 'block' : null,
    headStyleText: null,
    continuousThread: false,
    noHead: !headed,
    extraNotes: extra,
    thread: null,
    material: materialLabel(entries),
    name: itemName ?? '',
  };
}

interface FastenerGeom {
  headHalf: number; // real units
  headAxial: number; // real units
  shankLen: number; // real units
  total: number;
  genericHeadDia: boolean;
  genericHeadH: boolean;
}

function fastenerGeom(m: FastenerModel): FastenerGeom {
  const D = m.dia.mid;
  const L = m.len.mid;
  const hd = m.headDia ?? m.flats;
  const noHead = m.noHead;
  const headAxial = noHead ? 0 : m.headH ? m.headH.mid : Math.min(D * 0.75, L * 0.3);
  const shankLen = noHead ? L : m.underHead ? L : Math.max(D * 0.2, L - headAxial);
  return {
    headHalf: noHead ? D / 2 : hd ? hd.mid / 2 : D * 0.8,
    headAxial,
    shankLen,
    total: headAxial + shankLen,
    genericHeadDia: !noHead && !hd,
    genericHeadH: !noHead && !m.headH,
  };
}

const HEAD_LABEL_MAX = 150;
const RIGHT_EDGE = 726; // text must end before this x

interface FastenerLayout {
  sx0: number;
  xHead: number;
  xEnd: number;
  Hh: number;
  Sh: number;
  half: number;
  threadPx: number;
  full: boolean;
  scale: number;
  rows: { x1: number; x2: number; yFeat: number; label: string }[];
  overflow: boolean;
}

function layoutFastener(m: FastenerModel, g: FastenerGeom, scale: number, headLabel: string | null, diaLabel: string): FastenerLayout {
  const D = m.dia.mid;
  const sx0 = Math.max(76, headLabel ? 28 + Math.min(HEAD_LABEL_MAX, textWidth(headLabel)) + 44 : 0);
  const Hh = m.noHead ? 0 : Math.max(9, g.headHalf * scale);
  const Sh = Math.max(3.5, Math.min(m.noHead ? 1e9 : Hh - 1.5, (D / 2) * scale));
  const headLenPx = m.noHead ? 0 : Math.max(8, g.headAxial * scale);
  const shankPx = Math.max(10, g.shankLen * scale);
  const xHead = sx0 + headLenPx;
  const xEnd = xHead + shankPx;
  const full = m.kind === 'bolt' || m.kind === 'screw' ? !m.threadLen : m.kind === 'stud' ? m.continuousThread : false;
  const threadPx = m.threadLen ? Math.min(shankPx, Math.max(6, m.threadLen.mid * scale)) : shankPx;
  const rows: FastenerLayout['rows'] = [];
  if (m.headH && !m.noHead) rows.push({ x1: sx0, x2: xHead, yFeat: Hh, label: `${m.headH.text} ${m.kind === 'pin' ? 'HEIGHT' : 'HEAD H'}` });
  if (m.threadLen && !full && !m.noHead) rows.push({ x1: xEnd - threadPx, x2: xEnd, yFeat: Sh, label: `${m.threadLen.text} THREAD LG` });
  if (m.grip) rows.push({ x1: xHead, x2: Math.min(xEnd, xHead + m.grip.mid * scale), yFeat: Sh, label: `${m.grip.text} GRIP` });
  // Rows are stacked with the one that ends furthest right on top; each label sits to the right of its own
  // dimension line, so no extension line of a lower row can cross it.
  rows.sort((a, b) => b.x2 - a.x2);
  const overflow = xEnd + 30 + 9 + textWidth(diaLabel) > RIGHT_EDGE || rows.some((r) => r.x2 + 12 + textWidth(r.label) > RIGHT_EDGE);
  return { sx0, xHead, xEnd, Hh, Sh, half: Math.max(Hh, Sh), threadPx, full, scale, rows, overflow };
}

function drawFastener(m: FastenerModel, o: ShapeOpts): string | null {
  const g = fastenerGeom(m);
  const D = m.dia.mid;
  const headLabel = m.noHead ? null : m.headDia ? `⌀${m.headDia.text}` : m.flats ? `${m.flats.text} A/F` : null;
  const diaLabel = `⌀${m.dia.text}`;
  const sx0 = Math.max(76, headLabel ? 28 + Math.min(HEAD_LABEL_MAX, textWidth(headLabel)) + 44 : 0);
  let scale = Math.min((RIGHT_EDGE - 60 - textWidth(diaLabel) - sx0) / g.total, 130 / (2 * Math.max(g.headHalf, D / 2)));
  let L = layoutFastener(m, g, scale, headLabel, diaLabel);
  for (let i = 0; i < 24 && L.overflow; i++) {
    scale *= 0.93;
    L = layoutFastener(m, g, scale, headLabel, diaLabel);
  }
  if (L.overflow) return null;
  const { xHead, xEnd, Hh, Sh, half, threadPx, full } = L;
  const sx = L.sx0;
  const scy = 215;

  // head
  let head = '';
  const headLenPx = xHead - sx;
  if (!m.noHead) {
    if (m.headStyle === 'dome') {
      head = `<path d="M ${n(xHead)} ${n(scy - Hh)} A ${n(headLenPx)} ${n(Hh)} 0 0 0 ${n(xHead)} ${n(scy + Hh)} Z" class="dg-edge"/>`;
    } else if (m.headStyle === 'csk') {
      head = `<polygon points="${n(sx)},${n(scy - Hh)} ${n(xHead)},${n(scy - Sh)} ${n(xHead)},${n(scy + Sh)} ${n(sx)},${n(scy + Hh)}" class="dg-edge"/>`;
    } else {
      head = `<rect x="${n(sx)}" y="${n(scy - Hh)}" width="${n(headLenPx)}" height="${n(2 * Hh)}" class="dg-edge"/>`;
    }
  }
  // shank: threaded part hatched, the rest plain
  const shankPx = xEnd - xHead;
  let shank: string;
  if (m.kind === 'rivet' || m.kind === 'pin' || (m.kind === 'stud' && !m.continuousThread)) {
    shank = `<rect x="${n(xHead)}" y="${n(scy - Sh)}" width="${n(shankPx)}" height="${n(2 * Sh)}" class="dg-edge"/>`;
  } else if (full) {
    shank = `<rect x="${n(xHead)}" y="${n(scy - Sh)}" width="${n(shankPx)}" height="${n(2 * Sh)}" class="dg-thread"/>`;
  } else {
    shank =
      `<rect x="${n(xHead)}" y="${n(scy - Sh)}" width="${n(shankPx - threadPx)}" height="${n(2 * Sh)}" class="dg-edge"/>` +
      `<rect x="${n(xEnd - threadPx)}" y="${n(scy - Sh)}" width="${n(threadPx)}" height="${n(2 * Sh)}" class="dg-thread"/>`;
  }
  const view = `${txt((sx + xEnd) / 2, 64, 'SIDE VIEW', 'dg-label')}${head}${shank}${ln(sx - 14, scy, xEnd + 14, scy, 'dg-center')}`;

  // length dimension above
  const lgX1 = m.underHead || m.noHead ? xHead : sx;
  const lgLabel = m.underHead ? `${m.len.text} ${m.kind === 'pin' ? 'UNDER HEAD LG' : 'FASTENER LG'}` : `${m.len.text} ${m.noHead ? 'LG' : 'OVERALL LG'}`;
  const yLg = scy - half - 34;
  const lgFeat1 = m.underHead || m.noHead ? scy - Sh : scy - Hh;
  const dimLg = dimH(lgX1, xEnd, yLg, lgFeat1, scy - Sh, lgLabel, 'above', 'middle');
  const dimDia = dimV(scy - Sh, scy + Sh, xEnd + 30, xEnd, xEnd, diaLabel, 'right');
  const dimHeadDia = headLabel ? dimV(scy - Hh, scy + Hh, sx - 26, sx, sx, headLabel, 'left') : '';

  // rows below the part: line at the row's y, label to the right of the line
  let row = scy + half + 30;
  let below = '';
  for (const r of L.rows) {
    const yF = scy + r.yFeat;
    const ext = (x: number) => ln(x, yF + 5, x, row + 4, 'dg-ext');
    below += `${ext(r.x1)}${ext(r.x2)}${ln(r.x1, row, r.x2, row, 'dg-dimline')}${arrow(r.x1, row, 'l')}${arrow(r.x2, row, 'r')}${txt(r.x2 + 12, row + 4, r.label, 'dg-dim', 'start')}`;
    row += 30;
  }
  if (row - 30 > BODY_BOTTOM) return null;

  // what the catalog does not say
  const unknown: string[] = [];
  if (!m.noHead) {
    if (m.headStyle === null) unknown.push(m.headStyleText ? 'HEAD STYLE DRAWN' : 'HEAD STYLE');
    if (g.genericHeadDia) unknown.push('HEAD DIAMETER');
    if (g.genericHeadH) unknown.push('HEAD HEIGHT');
  }
  if ((m.kind === 'bolt' || m.kind === 'screw') && !m.threadLen) unknown.push('THREAD LENGTH');
  if (m.kind === 'stud' && !m.continuousThread) unknown.push('THREAD EXTENT');
  const notes = unknown.length ? [`NOT STATED OR NOT DRAWN: ${unknown.join(', ')}. SHOWN GENERIC`] : [];
  if (m.extraNotes.length) notes.push(`NOT DRAWN: ${m.extraNotes.join(', ')}`);
  return frame(view + dimLg + dimDia + dimHeadDia + below, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? (m.kind === 'rivet' ? 'RIVET' : m.kind === 'pin' ? 'PIN' : m.kind.toUpperCase()), m.material, m.thread ? `THREAD ${m.thread}` : null],
    notes,
  });
}

function thumbFastener(m: FastenerModel): string | null {
  const g = fastenerGeom(m);
  const D = m.dia.mid;
  const scale = Math.min(96 / g.total, 40 / (2 * Math.max(g.headHalf, D / 2)));
  const Hh = m.noHead ? 0 : Math.max(6, g.headHalf * scale);
  const Sh = Math.max(3, Math.min(m.noHead ? 1e9 : Hh - 1, (D / 2) * scale));
  const headLenPx = m.noHead ? 0 : Math.max(4, g.headAxial * scale);
  const shankPx = Math.max(8, g.shankLen * scale);
  const x0 = 60 - (headLenPx + shankPx) / 2;
  const xHead = x0 + headLenPx;
  const head = m.noHead ? '' : `<rect x="${n(x0)}" y="${n(60 - Hh)}" width="${n(headLenPx)}" height="${n(2 * Hh)}" ${THUMB_STROKE}/>`;
  return thumbWrap(`${head}<rect x="${n(xHead)}" y="${n(60 - Sh)}" width="${n(shankPx)}" height="${n(2 * Sh)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Annulus family: bearing, shaft seal, o-ring, packing, flat ring gasket, washer, ring spacer, round shim
// ---------------------------------------------------------------------------------------------

export type AnnulusKind = 'bearing' | 'seal' | 'gasket' | 'shim' | 'oring' | 'packing' | 'washer' | 'spacer';

interface AnnulusSpec {
  od: RegExp[];
  id: RegExp[];
  depth: RegExp[];
  fallbackTitle: string;
  odCaption: string;
  idCaption: string;
  depthWord: string; // WIDTH or THK
  note: string | null;
  /** The cross-section is a circle (o-ring). */
  round?: boolean;
  /** One diameter may be left out: it is then worked out from the other and the cross-section, and not labelled. */
  derive?: boolean;
  /** The part is still drawn (end view only) when no thickness is on file. */
  depthOptional?: boolean;
}

const ANNULUS: Record<AnnulusKind, AnnulusSpec> = {
  bearing: {
    od: [/^OVERALL OUTSIDE DIAMETER$/i, /^OUTSIDE DIAMETER$/i],
    id: [/^BORE DIAMETER$/i, /^OVERALL BORE DIAMETER$/i],
    depth: [/^OVERALL WIDTH$/i, /^WIDTH$/i],
    fallbackTitle: 'BEARING',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'BORE',
    depthWord: 'WIDTH',
    note: 'ENVELOPE ONLY: RINGS, BALLS OR ROLLERS, CAGE AND SEALS NOT DRAWN',
  },
  seal: {
    od: [/^OUTSIDE DIAMETER$/i, /^HOUSING BORE DIAMETER$/i],
    id: [/^ACCOMMODATED SHAFT DIAMETER$/i],
    depth: [/^SEAL WIDTH$/i],
    fallbackTitle: 'SEAL, PLAIN ENCASED',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'SHAFT DIA',
    depthWord: 'WIDTH',
    note: 'ENVELOPE ONLY: CASE AND SEALING ELEMENT NOT DRAWN',
  },
  gasket: {
    od: [/^OUTSIDE DIAMETER$/i],
    id: [/^APERTURE DIAMETER$/i, /^INSIDE DIAMETER$/i],
    depth: [/^CROSS-SECTIONAL THICKNESS$/i, /^OVERALL THICKNESS$/i, /^THICKNESS$/i],
    fallbackTitle: 'GASKET',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'APERTURE',
    depthWord: 'THK',
    note: null,
    depthOptional: true,
  },
  shim: {
    od: [/^OUTSIDE DIAMETER$/i],
    id: [/^APERTURE DIAMETER$/i, /^INSIDE DIAMETER$/i],
    depth: [/^OVERALL THICKNESS$/i, /^THICKNESS$/i, /^LAMINATION THICKNESS$/i],
    fallbackTitle: 'SHIM',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'APERTURE',
    depthWord: 'THK',
    note: null,
    depthOptional: true,
  },
  oring: {
    od: [/^OUTSIDE DIAMETER$/i, /^PERIPHERAL DIAMETER$/i],
    id: [/^CENTER HOLE DIAMETER$/i, /^INSIDE DIAMETER$/i],
    depth: [/^CROSS-SECTIONAL (?:HEIGHT|DIAMETER)$/i],
    fallbackTitle: 'O-RING',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'INSIDE DIA',
    depthWord: 'CROSS-SECTION',
    note: null,
    round: true,
    derive: true,
  },
  packing: {
    od: [/^PERIPHERAL DIAMETER$/i, /^OUTSIDE DIAMETER$/i],
    id: [/^CENTER HOLE DIAMETER$/i, /^INSIDE DIAMETER$/i],
    depth: [/^CROSS-SECTIONAL (?:HEIGHT|THICKNESS)$/i],
    fallbackTitle: 'PACKING, PREFORMED',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'INSIDE DIA',
    depthWord: 'HEIGHT',
    note: 'SECTION SHAPE NOT STATED, SHOWN AS A RECTANGLE',
    derive: true,
  },
  washer: {
    od: [/^OVERALL DIAMETER$/i, /^OUTSIDE DIAMETER$/i, /^WASHER OUTSIDE DIAMETER$/i],
    id: [/^HOLE DIAMETER$/i, /^INSIDE DIAMETER$/i],
    depth: [/^THICKNESS$/i, /^MATERIAL THICKNESS$/i],
    fallbackTitle: 'WASHER',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'HOLE',
    depthWord: 'THK',
    note: null,
    depthOptional: true,
  },
  spacer: {
    od: [/^OUTSIDE DIAMETER$/i],
    id: [/^INSIDE DIAMETER$/i],
    depth: [/^OVERALL THICKNESS$/i, /^THICKNESS$/i],
    fallbackTitle: 'SPACER, RING',
    odCaption: 'OUTSIDE DIA',
    idCaption: 'INSIDE DIA',
    depthWord: 'THK',
    note: null,
    depthOptional: true,
  },
};

export interface AnnulusModel {
  kind: AnnulusKind;
  unit: Unit;
  /** Stated values; null when the diameter was worked out (o-ring, packing) and so is not labelled. */
  od: Meas | null;
  id: Meas | null;
  /** Values the geometry is drawn from. */
  odG: number;
  idG: number;
  depth: Meas | null;
  odCaption: string;
  housing: Meas | null;
  /** True for a plain flat washer; other washer forms get an end view only. */
  flat: boolean;
  formName: string;
  notes: string[];
  material: string | null;
}

const BEARING_NOT_ENVELOPE = /\b(TAPER(?:ED)?|ROD|AIRFRAME|THRUST|PILLOW|MOUNTED|CAM|CAGE|SPHERICAL|CONE|CUP|FOLLOWER|MAGNETIC|GEAR)\b/;
const NOT_ROUND_TEXT = /\b(IRREGULAR|OBLONG|RECTANGULAR|OVAL|ELLIPTICAL|NON-?CIRCULAR|SQUARE|TRIANGULAR|KIDNEY)\b/;

export function annulusKindFor(fsc: string, itemName: string | null): AnnulusKind | null {
  const name = upper(itemName);
  const root = rootOf(itemName);
  const toks = tokensOf(itemName);
  const rest = toks.slice(1);
  if (fsc === '3110' && root === 'BEARING' && !BEARING_NOT_ENVELOPE.test(name)) return 'bearing';
  if (fsc === '5330' || fsc === '5331') {
    if (root === 'O-RING') return rest.length === 0 ? 'oring' : null;
    if (root === 'SEAL' && rest.every((t) => t === 'PLAIN' || t === 'ENCASED')) return 'seal';
    if (root === 'GASKET' && rest.every((t) => t === 'SPIRAL' || t === 'WOUND')) return 'gasket';
    if (root === 'PACKING' && rest.length === 1 && rest[0] === 'PREFORMED') return 'packing';
    if (root === 'RETAINER' && rest.length === 1 && rest[0] === 'PACKING') return 'packing';
  }
  if (fsc === '5365' && root === 'SHIM' && rest.length === 0) return 'shim';
  if (fsc === '5365' && root === 'SPACER' && rest.length === 1 && rest[0] === 'RING') return 'spacer';
  if (fsc === '5310' && root === 'WASHER') return 'washer';
  return null;
}

export function annulusModel(entries: CharacteristicEntry[], kind: AnnulusKind, itemName: string | null = null): AnnulusModel | null {
  const spec = ANNULUS[kind];
  // both a height and a thickness stated: the section is not a plain square, so it is not drawn
  if (kind === 'packing' && hasReq(entries, /^CROSS-SECTIONAL HEIGHT$/i) && hasReq(entries, /^CROSS-SECTIONAL THICKNESS$/i)) return null;
  const od = getMeas(entries, spec.od);
  const id = getMeas(entries, spec.id);
  const depth = getMeas(entries, spec.depth);
  // a requirement that is on file but unusable (qualified, repeated, mixed) is not quietly replaced by a guess
  if (spec.derive ? !depth || (!od && !id) : !od || !id) return null;
  if (!spec.depthOptional && !spec.derive && !depth) return null;
  if (hasReq(entries, spec.depth[0]) && !depth && !spec.depthOptional) return null;
  const unit = sharedUnit(od, id, depth);
  if (!unit) return null;
  let odG: number;
  let idG: number;
  if (od && id) {
    odG = od.mid;
    idG = id.mid;
  } else if (od) {
    odG = od.mid;
    idG = od.mid - 2 * (depth as Meas).mid;
  } else {
    idG = (id as Meas).mid;
    odG = idG + 2 * (depth as Meas).mid;
  }
  if (!(odG > idG) || !(idG > 0)) return null;
  // an o-ring whose three stated sizes disagree is not drawn: the wall must match the cross-section
  if (kind === 'oring' && od && id && depth && Math.abs((od.mid - id.mid) / 2 - depth.mid) > 0.25 * depth.mid) return null;
  // a flat gasket or spacer must be a round ring: no length/width, no stated odd shape
  if (kind === 'gasket' || kind === 'packing' || kind === 'spacer') {
    if (hasReq(entries, /^(?:OVERALL (?:LENGTH|WIDTH)|APERTURE (?:LENGTH|WIDTH))$/i)) return null;
    if (entries.some((e) => e.requirement && /^(?:SPECIAL|SUPPLEMENTARY) FEATURES$|^CROSS-SECTIONAL SHAPE STYLE$|^STYLE DESIGNATOR$|^PART NAME ASSIGNED BY CONTROLLING AGENCY$/i.test(e.requirement) && NOT_ROUND_TEXT.test(upper(e.reply)))) return null;
  }
  const hasOutside = hasReq(entries, /^OUTSIDE DIAMETER$/i);
  const odCaption = kind === 'seal' && !hasOutside ? 'HOUSING BORE' : spec.odCaption;
  const housing = kind === 'seal' && hasOutside ? same(getMeas(entries, [/^HOUSING BORE DIAMETER$/i]), unit) : null;
  const toks = tokensOf(itemName);
  const flat = kind !== 'washer' || toks.length === 1 || (toks.length === 2 && toks[1] === 'FLAT');
  const formName = toks.slice(1).join(' ');
  const notes: string[] = [];
  if (kind === 'washer' && !flat) notes.push(`ENVELOPE ONLY: ${formName} FORM NOT DRAWN`);
  else if (spec.note) notes.push(spec.note);
  if (kind === 'oring' && (!od || !id)) notes.push(`${!od ? 'OUTSIDE' : 'INSIDE'} DIA NOT STATED`);
  if (kind === 'packing' && (!od || !id)) notes.push(`${!od ? 'OUTSIDE' : 'INSIDE'} DIA NOT STATED`);
  if (!depth) notes.push('THICKNESS NOT STATED');
  if (kind === 'gasket') {
    const extra: string[] = [];
    if (hasReq(entries, /^BOLT (?:HOLE QUANTITY|CIRCLE DIAMETER)$|^HOLE DIAMETER$/i)) extra.push('BOLT HOLES');
    if (/SPIRAL/.test(upper(itemName))) extra.push('WINDING AND GAGE RING');
    if (extra.length) notes.push(`NOT DRAWN: ${extra.join(', ')}`);
  }
  return { kind, unit, od, id, odG, idG, depth, odCaption, housing, flat, formName, notes, material: materialLabel(entries) };
}

function drawAnnulus(m: AnnulusModel, o: ShapeOpts): string | null {
  const spec = ANNULUS[m.kind];
  const section = !!m.depth && m.flat;
  // ---- end view (left; centred when there is no section) ----
  const ex = section ? 150 : 250;
  const ey = 232;
  const R = 108;
  const r = Math.max(12, R * (m.idG / m.odG));
  const ang = (deg: number, rad: number) => [ex + rad * Math.cos((deg * Math.PI) / 180), ey - rad * Math.sin((deg * Math.PI) / 180)] as const;
  const [odX, odY] = ang(52, R);
  const [idX, idY] = ang(-28, r);
  const labelX = ex + R + 26;
  const endView = `
    ${txt(ex, 64, 'END VIEW', 'dg-label')}
    ${ln(ex - R - 18, ey, ex + R + 14, ey, 'dg-center')}
    ${ln(ex, ey - R - 18, ex, ey + R + 18, 'dg-center')}
    <circle cx="${n(ex)}" cy="${n(ey)}" r="${n(R)}" class="dg-edge"/>
    <circle cx="${n(ex)}" cy="${n(ey)}" r="${n(r)}" class="dg-edge"/>
    ${m.od ? leader(odX, odY, labelX, 138, m.odCaption, `⌀${m.od.text}`) : ''}
    ${m.id ? leader(idX, idY, labelX, 276, spec.idCaption, `⌀${m.id.text}`) : ''}`;

  let sec = '';
  if (section && m.depth) {
    // ---- section (right): the two wall bars of an axial cut ----
    const wall = (m.odG - m.idG) / 2;
    const trueScale = Math.min(250 / m.odG, 170 / m.depth.mid);
    const trueOk = Math.min(wall, m.depth.mid) * trueScale >= 22;
    let sc: number;
    let gapPx: number;
    if (trueOk) {
      sc = trueScale;
      gapPx = m.idG * sc;
    } else {
      sc = Math.min(95 / wall, 140 / m.depth.mid);
      gapPx = Math.min(110, Math.max(46, wall * sc));
    }
    const wallPx = wall * sc;
    const depPx = m.depth.mid * sc;
    const cx = 565;
    const cy = 232;
    const xL0 = cx - gapPx / 2 - wallPx;
    const xR0 = cx + gapPx / 2;
    const top = cy - depPx / 2;
    const bot = cy + depPx / 2;
    const dimX = xR0 + wallPx + 24;
    const bars = spec.round
      ? `<ellipse cx="${n(xL0 + wallPx / 2)}" cy="${n(cy)}" rx="${n(wallPx / 2)}" ry="${n(depPx / 2)}" class="dg-sec"/><ellipse cx="${n(xR0 + wallPx / 2)}" cy="${n(cy)}" rx="${n(wallPx / 2)}" ry="${n(depPx / 2)}" class="dg-sec"/>`
      : `<rect x="${n(xL0)}" y="${n(top)}" width="${n(wallPx)}" height="${n(depPx)}" class="dg-sec"/><rect x="${n(xR0)}" y="${n(top)}" width="${n(wallPx)}" height="${n(depPx)}" class="dg-sec"/>`;
    sec = `
    ${txt(cx, 64, m.kind === 'bearing' || m.kind === 'seal' ? 'SECTION' : 'SECTION A-A', 'dg-label')}
    ${trueOk ? '' : txt(cx, 80, '(ENLARGED)', 'dg-note')}
    ${bars}
    ${ln(xL0 - 16, cy, xR0 + wallPx + 16, cy, 'dg-center')}
    ${dimV(top, bot, dimX, xR0 + wallPx, xR0 + wallPx, null, 'right')}
    ${txt(cx, bot + 42, `${m.depth.text} ${spec.depthWord}`, 'dg-dim')}`;
    if (bot + 42 > BODY_BOTTOM || dimX > 732) return null;
  } else if (m.depth) {
    // non-flat washer: the thickness is stock thickness, so it is stated but no wall is drawn
    sec = txt(ex, ey + R + 40, `${m.depth.text} MATERIAL THK`, 'dg-dim');
    if (ey + R + 40 > BODY_BOTTOM) return null;
  }

  const items = [o.itemName ?? spec.fallbackTitle, m.material, m.housing ? `HOUSING BORE ⌀${m.housing.text}` : null];
  return frame(endView + sec, { nsnDashed: o.nsnDashed, unit: m.unit, items, notes: m.notes });
}

function thumbAnnulus(m: AnnulusModel): string | null {
  const R = 50;
  const r = Math.max(8, R * (m.idG / m.odG));
  return thumbWrap(`${thumbCircle(60, 60, R)}${thumbCircle(60, 60, r)}`);
}

// ---------------------------------------------------------------------------------------------
// Helical compression spring (FSC 5360)
// ---------------------------------------------------------------------------------------------

export interface SpringModel {
  unit: Unit;
  len: Meas;
  od: Meas;
  id: Meas | null;
  wire: Meas | null;
  wireG: number;
  coils: number | null;
  material: string | null;
  variant: SpringVariant;
}

export type SpringVariant = 'compression' | 'extension' | 'torsion';

export function springKindFor(fsc: string, itemName: string | null): SpringVariant | null {
  if (fsc !== '5360' || rootOf(itemName) !== 'SPRING') return null;
  const rest = tokensOf(itemName).slice(1);
  if (rest.length !== 2 || rest[0] !== 'HELICAL') return null;
  if (/^COMP(?:RES|RESSION)?$/.test(rest[1])) return 'compression';
  if (rest[1] === 'EXTENSION') return 'extension';
  if (rest[1] === 'TORSION' || rest[1] === 'TORS') return 'torsion';
  return null;
}

export function springModel(entries: CharacteristicEntry[], variant: SpringVariant = 'compression'): SpringModel | null {
  const len = getMeas(entries, [/^SPRING FREE LENGTH$/i]);
  const od = getMeas(entries, [/^SPRING FREE OUTSIDE DIAMETER$/i]);
  const id = getMeas(entries, [/^INSIDE DIAMETER$/i]);
  const wire = getMeas(entries, [/^STOCK DIAMETER$/i]);
  if (!len || !od || (!id && !wire)) return null;
  const unit = sharedUnit(len, od, id, wire);
  if (!unit) return null;
  if (id && !(od.mid > id.mid)) return null;
  const wireG = wire ? wire.mid : (od.mid - (id as Meas).mid) / 2;
  if (!(wireG > 0) || wireG * 2 >= od.mid * 1.0001) return null;
  // stated stock diameter and diameters must agree, or the coil cannot be drawn honestly
  if (wire && id && Math.abs((od.mid - id.mid) / 2 - wire.mid) > 0.2 * wire.mid) return null;
  const cq = getText(entries, [/^COIL QUANTITY$/i]);
  const coils = cq && /^\d{1,2}(?:\.\d)?$/.test(cq) && Number(cq) >= 2 ? Number(cq) : null;
  return { unit, len, od, id, wire, wireG, coils, material: materialLabel(entries), variant };
}

function springPoints(x0: number, lenPx: number, yTop: number, yBot: number, turns: number): string {
  const pts: string[] = [];
  const p = lenPx / turns;
  for (let i = 0; i <= turns; i++) {
    pts.push(`${n(x0 + i * p)},${n(i % 2 === 0 ? yTop : yBot)}`);
  }
  return pts.join(' ');
}

function drawSpring(m: SpringModel, o: ShapeOpts): string | null {
  const sc = Math.min(440 / m.len.mid, 150 / m.od.mid);
  const lenPx = m.len.mid * sc;
  const odPx = m.od.mid * sc;
  const wPx = Math.min(16, Math.max(3, m.wireG * sc));
  if (!(lenPx >= 30) || !(odPx >= 24)) return null;
  const x0 = Math.max(150, 380 - lenPx / 2);
  const cy = 235;
  const top = cy - odPx / 2;
  const bot = cy + odPx / 2;
  // turns: as stated when they fit, else as many as fit (and the note says so)
  const maxTurns = Math.max(2, Math.floor(lenPx / (wPx * 1.3)));
  let turns = m.coils !== null ? Math.round(m.coils * 2) : 12; // two strokes per turn
  let generic = m.coils === null;
  if (turns > maxTurns) {
    turns = maxTurns;
    generic = true;
  }
  const wire = `<polyline points="${springPoints(x0, lenPx, top + wPx / 2, bot - wPx / 2, turns)}" fill="none" stroke="var(--ink)" stroke-width="${n(wPx)}" stroke-linejoin="miter" stroke-linecap="butt" opacity="0.9"/>`;
  const view = `${txt(x0 + lenPx / 2, 64, 'SIDE VIEW', 'dg-label')}${wire}${ln(x0 - 20, cy, x0 + lenPx + 20, cy, 'dg-center')}`;
  const dimLen = dimH(x0, x0 + lenPx, top - 34, top, top, `${m.len.text} FREE LG`, 'above', 'middle');
  const dimOd = dimV(top, bot, x0 + lenPx + 34, x0 + lenPx, x0 + lenPx, `⌀${m.od.text} O.D.`, 'right');
  const dimId = m.id ? dimV(top + wPx, bot - wPx, x0 - 34, x0, x0, `⌀${m.id.text} I.D.`, 'left') : '';
  if (x0 + lenPx + 34 + 9 + textWidth(`⌀${m.od.text} O.D.`) > 740 || x0 - 34 - 9 - textWidth(m.id ? `⌀${m.id.text} I.D.` : '') < 20) return null;
  const endNote = m.variant === 'extension' ? 'HOOKS NOT DRAWN, LENGTH AS STATED' : m.variant === 'torsion' ? 'LEGS NOT DRAWN' : 'END FORM NOT DRAWN';
  const notes = [endNote, generic ? 'TURN COUNT SHOWN GENERIC' : 'TURNS AS STATED'];
  return frame(view + dimLen + dimOd + dimId, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? `SPRING, HELICAL, ${m.variant.toUpperCase()}`, m.wire ? `WIRE ⌀${m.wire.text}` : null, m.material],
    notes,
  });
}

function thumbSpring2(m: SpringModel): string | null {
  const sc = Math.min(96 / m.len.mid, 50 / m.od.mid);
  const L = m.len.mid * sc;
  const D = m.od.mid * sc;
  const w = Math.max(2, Math.min(6, m.wireG * sc));
  const x0 = 60 - L / 2;
  const pts = springPoints(x0, L, 60 - D / 2 + w / 2, 60 + D / 2 - w / 2, Math.max(2, Math.min(10, Math.floor(L / (w * 1.5)))));
  return thumbWrap(`<polyline points="${pts}" fill="none" stroke="var(--ink)" stroke-width="${n(Math.max(2, w))}" stroke-linejoin="miter"/>`);
}

// ---------------------------------------------------------------------------------------------
// Retaining ring (internal or external, free state)
// ---------------------------------------------------------------------------------------------

export interface RetainingModel {
  unit: Unit;
  od: Meas | null;
  id: Meas | null;
  thk: Meas;
  usage: 'INTERNAL' | 'EXTERNAL' | null;
  material: string | null;
}

export function retainingKindFor(fsc: string, itemName: string | null): boolean {
  return (fsc === '5325' || fsc === '5365') && rootOf(itemName) === 'RING' && tokensOf(itemName).includes('RETAINING');
}

export function retainingModel(entries: CharacteristicEntry[]): RetainingModel | null {
  const od = getMeas(entries, [/^OUTSIDE DIAMETER$/i, /^FREE OUTSIDE DIAMETER$/i]);
  const id = getMeas(entries, [/^INSIDE DIAMETER$/i, /^FREE INSIDE DIAMETER$/i]);
  const thk = getMeas(entries, [/^(?:MAJOR |OVERALL )?THICKNESS$/i]);
  if (!thk || (!od && !id)) return null;
  const unit = sharedUnit(od, id, thk);
  if (!unit) return null;
  if (od && id && !(od.mid > id.mid)) return null;
  const u = upper(getText(entries, [/^USAGE DESIGN$/i]));
  return { unit, od, id, thk, usage: u === 'INTERNAL' || u === 'EXTERNAL' ? u : null, material: materialLabel(entries) };
}

function ringPath(cx: number, cy: number, R: number, r: number, gapDeg: number): string {
  const p = (deg: number, rad: number) => `${n(cx + rad * Math.cos((deg * Math.PI) / 180))} ${n(cy - rad * Math.sin((deg * Math.PI) / 180))}`;
  // from just above the gap, the long way round (counter-clockwise on screen), to just below it
  return `M ${p(gapDeg, R)} A ${n(R)} ${n(R)} 0 1 0 ${p(-gapDeg, R)} L ${p(-gapDeg, r)} A ${n(r)} ${n(r)} 0 1 1 ${p(gapDeg, r)} Z`;
}

function drawRetaining(m: RetainingModel, o: ShapeOpts): string | null {
  const cx = 170;
  const cy = 226;
  const R = 108;
  const both = m.od && m.id;
  const r = both ? Math.max(14, R * ((m.id as Meas).mid / (m.od as Meas).mid)) : R * 0.86;
  const endView = `
    ${txt(cx, 64, 'FREE STATE', 'dg-label')}
    ${ln(cx - R - 18, cy, cx + R + 14, cy, 'dg-center')}
    ${ln(cx, cy - R - 18, cx, cy + R + 18, 'dg-center')}
    <path d="${ringPath(cx, cy, R, r, 11)}" class="dg-edge"/>`;
  const odDim = m.od ? dimH(cx - R, cx + R, cy + R + 30, cy + R, cy + R, `⌀${m.od.text} O.D.`, 'below') : '';
  let idLeader = '';
  if (m.id) {
    const a = (-60 * Math.PI) / 180;
    idLeader = leader(cx + r * Math.cos(a), cy - r * Math.sin(a), cx + R + 26, cy + 70, 'INSIDE DIA', `⌀${m.id.text}`);
  }
  // section: one bar, radial width by thickness
  const sx = 575;
  const sy = 226;
  const wallReal = both ? ((m.od as Meas).mid - (m.id as Meas).mid) / 2 : null;
  let barW: number;
  let barH: number;
  if (wallReal !== null) {
    const sc = Math.min(130 / wallReal, 130 / m.thk.mid);
    barW = Math.max(10, wallReal * sc);
    barH = Math.max(10, m.thk.mid * sc);
  } else {
    barW = 110;
    barH = 34;
  }
  const x0 = sx - barW / 2;
  const section = `
    ${txt(sx, 64, 'SECTION', 'dg-label')}
    ${txt(sx, 80, wallReal !== null ? '(ENLARGED)' : '(NOT TO SCALE)', 'dg-note')}
    <rect x="${n(x0)}" y="${n(sy - barH / 2)}" width="${n(barW)}" height="${n(barH)}" class="dg-sec"/>
    ${dimV(sy - barH / 2, sy + barH / 2, x0 + barW + 26, x0 + barW, x0 + barW, null, 'right')}
    ${txt(sx, sy + barH / 2 + 42, `${m.thk.text} THK`, 'dg-dim')}`;
  const unknown: string[] = [];
  if (!both) unknown.push('RADIAL WIDTH');
  unknown.push('GAP AND LUGS');
  return frame(endView + odDim + idLeader + section, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'RING, RETAINING', m.usage ? `${m.usage} RING` : null, m.material],
    notes: [`NOT STATED OR NOT DRAWN TO SCALE: ${unknown.join(', ')}`],
  });
}

function thumbRetaining(): string | null {
  return thumbWrap(`<path d="${ringPath(60, 60, 48, 40, 11)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Loop clamp (cushioned or plain): loop, band width and thickness, optional tongue with hole
// ---------------------------------------------------------------------------------------------

export interface LoopModel {
  unit: Unit;
  loopId: Meas;
  width: Meas;
  thk: Meas;
  holeC2C: Meas | null;
  tongueEnd: Meas | null;
  holeDia: Meas | null;
  material: string | null;
}

export function loopKindFor(fsc: string, itemName: string | null): boolean {
  return fsc === '5340' && rootOf(itemName) === 'CLAMP' && tokensOf(itemName).includes('LOOP');
}

export function loopModel(entries: CharacteristicEntry[]): LoopModel | null {
  const loopId = getMeas(entries, [/^LOOP INSIDE DIAMETER$/i]);
  const width = getMeas(entries, [/^LOOP WIDTH$/i, /^OVERALL WIDTH$/i]);
  const thk = getMeas(entries, [/^MATERIAL THICKNESS$/i]);
  if (!loopId || !width || !thk) return null;
  const unit = sharedUnit(loopId, width, thk);
  if (!unit) return null;
  const opt = (pats: RegExp[]) => same(getMeas(entries, pats), unit);
  const holeC2C = opt([/^CENTER TO CENTER DISTANCE BETWEEN LOOP AND MOUNTING HOLE$/i]);
  let tongueEnd = opt([/^DISTANCE FROM LOOP CENTER TO TONGUE END$/i]);
  const holeDia = hasReq(entries, /^TONGUE HOLE TYPE$/i) ? opt([/^DIAMETER$/i]) : null;
  const loopOD = loopId.mid + 2 * thk.mid;
  // the tongue must reach past the loop wall, and the hole must lie inside the tongue
  if (tongueEnd && !(tongueEnd.mid > loopOD / 2)) tongueEnd = null;
  if (holeC2C && !(holeC2C.mid > loopOD / 2)) return null;
  if (holeC2C && tongueEnd && !(tongueEnd.mid > holeC2C.mid)) tongueEnd = null;
  return { unit, loopId, width, thk, holeC2C, tongueEnd, holeDia, material: materialLabel(entries) };
}

function drawLoop(m: LoopModel, o: ShapeOpts): string | null {
  const idR = m.loopId.mid / 2;
  const odR = idR + m.thk.mid;
  const tongueLen = m.tongueEnd ? m.tongueEnd.mid : m.holeC2C ? m.holeC2C.mid + (m.holeDia ? m.holeDia.mid : odR * 0.3) * 1.2 : odR;
  const reach = Math.max(odR, tongueLen);
  // Front and top views share one scale and one x axis (orthographic projection).
  const x0 = 140; // left edge of the loop in both views
  const scale = Math.min((620 - x0) / (odR + reach), 62 / odR, 58 / m.width.mid);
  const R = odR * scale;
  const r = Math.max(3, idR * scale);
  const cx = x0 + R;
  const xTip = cx + tongueLen * scale;
  const tPx = Math.max(2.2, m.thk.mid * scale);
  const fy = 104 + R;
  const mid = (x0 + xTip) / 2;
  const front = `
    ${txt(mid, 64, 'FRONT VIEW', 'dg-label')}
    <circle cx="${n(cx)}" cy="${n(fy)}" r="${n(R)}" class="dg-edge"/>
    <circle cx="${n(cx)}" cy="${n(fy)}" r="${n(r)}" class="dg-edge"/>
    <rect x="${n(cx + R - 1)}" y="${n(fy - tPx)}" width="${n(Math.max(2, xTip - (cx + R) + 1))}" height="${n(2 * tPx)}" class="dg-edge"/>
    ${ln(x0 - 14, fy, xTip + 12, fy, 'dg-center')}
    ${ln(cx, fy - R - 12, cx, fy + R + 12, 'dg-center')}
    ${txt(xTip + 22, fy + 4, `${m.thk.text} THK`, 'dg-dim', 'start')}
    ${leader(cx + r * Math.cos(0.87), fy - r * Math.sin(0.87), 560, fy - 52, 'LOOP INSIDE DIA', `⌀${m.loopId.text}`)}`;
  // top view: the band's width by the tongue length, below the front view
  const wPx = m.width.mid * scale;
  const ty = fy + R + 52 + wPx / 2;
  const topEdge = ty - wPx / 2;
  const botEdge = ty + wPx / 2;
  let top = `
    ${txt(mid, topEdge - 14, 'TOP VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(topEdge)}" width="${n(xTip - x0)}" height="${n(wPx)}" class="dg-edge"/>
    ${ln(cx, topEdge - 8, cx, botEdge + 8, 'dg-center')}
    ${dimV(topEdge, botEdge, x0 - 26, x0, x0, `${m.width.text} WIDE`, 'left')}`;
  const rows: { x2: number; label: string }[] = [];
  if (m.holeC2C) {
    const hx = cx + m.holeC2C.mid * scale;
    if (m.holeDia) {
      const hr = Math.max(1.5, (m.holeDia.mid / 2) * scale);
      top += `<circle cx="${n(hx)}" cy="${n(ty)}" r="${n(hr)}" class="dg-edge"/>${ln(hx, ty - hr - 7, hx, ty + hr + 7, 'dg-center')}${ln(hx - hr - 7, ty, hx + hr + 7, ty, 'dg-center')}`;
      top += leader(hx + hr * 0.7, ty - hr * 0.7, Math.max(xTip + 24, 560), ty - 14, 'HOLE DIA', `⌀${m.holeDia.text}`);
    } else {
      top += `${ln(hx - 6, ty, hx + 6, ty, 'dg-center')}${ln(hx, ty - 6, hx, ty + 6, 'dg-center')}`;
    }
    rows.push({ x2: hx, label: `${m.holeC2C.text} TO HOLE` });
  }
  if (m.tongueEnd) rows.push({ x2: xTip, label: `${m.tongueEnd.text} TO END` });
  rows.sort((a, b) => b.x2 - a.x2);
  let rowY = botEdge + 28;
  for (const r2 of rows) {
    const ext = (x: number) => ln(x, botEdge + 5, x, rowY + 4, 'dg-ext');
    top += `${ext(cx)}${ext(r2.x2)}${ln(cx, rowY, r2.x2, rowY, 'dg-dimline')}${arrow(cx, rowY, 'l')}${arrow(r2.x2, rowY, 'r')}${txt(r2.x2 + 12, rowY + 4, r2.label, 'dg-dim', 'start')}`;
    rowY += 28;
  }
  if (rowY - 28 > BODY_BOTTOM - 6) return null;
  const unknown: string[] = [];
  if (!m.holeC2C) unknown.push('TONGUE AND HOLE');
  else if (!m.tongueEnd) unknown.push('TONGUE END');
  if (m.holeC2C && !m.holeDia) unknown.push('HOLE DIAMETER');
  const stub = !m.holeC2C || !m.tongueEnd;
  return frame(front + top, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'CLAMP, LOOP', m.material],
    notes: unknown.length ? [`NOT STATED: ${unknown.join(', ')}.${stub ? ' TONGUE LENGTH SHOWN AS A STUB' : ''}`] : [],
  });
}

function thumbLoop(m: LoopModel): string | null {
  const odR = m.loopId.mid / 2 + m.thk.mid;
  const tongue = m.tongueEnd ? m.tongueEnd.mid : m.holeC2C ? m.holeC2C.mid * 1.25 : odR * 1.4;
  const span = odR + Math.max(odR, tongue);
  const s = Math.min(96 / span, 76 / (2 * odR));
  const R = odR * s;
  const r = Math.max(4, (m.loopId.mid / 2) * s);
  const x0 = 60 - (R + Math.max(R, tongue * s)) / 2 + R;
  return thumbWrap(
    `${thumbCircle(x0, 60, R)}${thumbCircle(x0, 60, r)}<rect x="${n(x0 + R - 1)}" y="${n(60 - Math.max(2, m.thk.mid * s))}" width="${n(Math.max(4, tongue * s - R + 1))}" height="${n(Math.max(4, 2 * m.thk.mid * s))}" ${THUMB_STROKE}/>`
  );
}

// ---------------------------------------------------------------------------------------------
// Machine key: a rectangular bar. Length, width and height are all required.
// ---------------------------------------------------------------------------------------------

export interface KeyModel {
  unit: Unit;
  len: Meas;
  width: Meas;
  height: Meas;
  material: string | null;
}

export function keyKindFor(fsc: string, itemName: string | null): boolean {
  return fsc === '5315' && rootOf(itemName) === 'KEY' && tokensOf(itemName).includes('MACHINE');
}

export function keyModel(entries: CharacteristicEntry[]): KeyModel | null {
  const len = getMeas(entries, [/^OVERALL LENGTH$/i, /^LENGTH$/i]);
  const width = getMeas(entries, [/^OVERALL WIDTH$/i, /^WIDTH$/i]);
  const height = getMeas(entries, [/^OVERALL HEIGHT$/i, /^HEIGHT$/i]);
  if (!len || !width || !height) return null;
  const unit = sharedUnit(len, width, height);
  if (!unit) return null;
  return { unit, len, width, height, material: materialLabel(entries) };
}

function drawKey(m: KeyModel, o: ShapeOpts): string | null {
  const L = m.len.mid;
  const W = m.width.mid;
  const H = m.height.mid;
  const sc = Math.min(430 / L, 244 / (W + H), 100 / W, 100 / H);
  const lp = L * sc;
  const wp = Math.max(8, W * sc);
  const hp = Math.max(8, H * sc);
  const x0 = 70;
  const topEdge = 120;
  const topY = topEdge + wp / 2;
  const sideEdge = topEdge + wp + 66;
  const sideY = sideEdge + hp / 2;
  const top = `
    ${txt(x0 + lp / 2, 64, 'TOP VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(topEdge)}" width="${n(lp)}" height="${n(wp)}" class="dg-edge"/>
    ${dimH(x0, x0 + lp, topEdge - 12, topEdge, topEdge, `${m.len.text} LG`, 'above')}
    ${dimV(topEdge, topEdge + wp, x0 + lp + 26, x0 + lp, x0 + lp, `${m.width.text} W`, 'right')}`;
  const side = `
    ${txt(x0 + lp / 2, sideEdge - 14, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(sideEdge)}" width="${n(lp)}" height="${n(hp)}" class="dg-edge"/>
    ${dimV(sideEdge, sideEdge + hp, x0 + lp + 26, x0 + lp, x0 + lp, `${m.height.text} H`, 'right')}`;
  void topY;
  void sideY;
  const labelW = Math.max(textWidth(`${m.width.text} W`), textWidth(`${m.height.text} H`));
  if (sideEdge + hp > BODY_BOTTOM || x0 + lp + 26 + 9 + labelW > 732) return null;
  return frame(top + side, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'KEY, MACHINE', m.material],
    notes: ['NOT STATED: END SHAPE, KEYWAY FIT, CHAMFERS. SHOWN AS A PLAIN BAR'],
  });
}

function thumbKey(m: KeyModel): string | null {
  const s = Math.min(96 / m.len.mid, 44 / m.width.mid);
  const w = Math.max(10, m.len.mid * s);
  const h = Math.max(8, m.width.mid * s);
  return thumbWrap(`<rect x="${n(60 - w / 2)}" y="${n(60 - h / 2)}" width="${n(w)}" height="${n(h)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// One entry point: which family does this part belong to, and does it have the dimensions?
// ---------------------------------------------------------------------------------------------

export interface Resolved {
  /** True when this module owns the part's family: the caller must not fall back to an older builder. */
  claimed: boolean;
  shape: Shape | null;
}

const NONE: Resolved = { claimed: false, shape: null };

const OLD_FALLBACK = new Set<AnnulusKind>(['washer', 'oring', 'packing', 'gasket', 'spacer']);

export function resolveShape(entries: CharacteristicEntry[], fsc: string, itemName: string | null): Resolved {
  const more = resolveMore(entries, fsc, itemName);
  if (more) return more;
  const fk = fastenerKindFor(fsc, itemName);
  if (fsc === '5305' || fsc === '5306' || fsc === '5307' || fk === 'rivet' || fk === 'pin') {
    // 5315 names that are not a straight pin stay with the older pin builder (and its name filter)
    if (!fk) return fsc === '5315' ? NONE : { claimed: true, shape: null };
    const m = fastenerModel(entries, fk, itemName);
    return { claimed: true, shape: m ? { kind: fk, draw: (o) => drawFastener(m, o), thumb: () => thumbFastener(m) } : null };
  }
  const ak = annulusKindFor(fsc, itemName);
  if (ak) {
    const m = annulusModel(entries, ak, itemName);
    // washers, o-rings, packings, gaskets and ring spacers the data cannot draw may still be drawn by an older builder
    return { claimed: !!m || !OLD_FALLBACK.has(ak), shape: m ? { kind: ak, draw: (o) => drawAnnulus(m, o), thumb: () => thumbAnnulus(m) } : null };
  }
  const sk = springKindFor(fsc, itemName);
  if (sk) {
    const m = springModel(entries, sk);
    // a spring the data cannot draw may still be drawn by the older spring builder
    return m ? { claimed: true, shape: { kind: 'spring', draw: (o) => drawSpring(m, o), thumb: () => thumbSpring2(m) } } : NONE;
  }
  if (retainingKindFor(fsc, itemName)) {
    const m = retainingModel(entries);
    return { claimed: true, shape: m ? { kind: 'retaining', draw: (o) => drawRetaining(m, o), thumb: () => thumbRetaining() } : null };
  }
  if (loopKindFor(fsc, itemName)) {
    const m = loopModel(entries);
    return { claimed: true, shape: m ? { kind: 'loop', draw: (o) => drawLoop(m, o), thumb: () => thumbLoop(m) } : null };
  }
  if (keyKindFor(fsc, itemName)) {
    const m = keyModel(entries);
    return { claimed: true, shape: m ? { kind: 'key', draw: (o) => drawKey(m, o), thumb: () => thumbKey(m) } : null };
  }
  return NONE;
}

// Exported builders (same signature as the older ones, so tests and the coverage script can call them by name).
const viaShape = (want: (fsc: string, name: string | null) => boolean, fsc: string) => (entries: CharacteristicEntry[], o: ShapeOpts): string | null => {
  if (!want(fsc, o.itemName)) return null;
  return resolveShape(entries, fsc, o.itemName).shape?.draw(o) ?? null;
};
export const buildBoltDiagram = viaShape((f, nm) => fastenerKindFor(f, nm) === 'bolt', '5306');
export const buildStudDiagram = viaShape((f, nm) => fastenerKindFor(f, nm) === 'stud', '5307');
export const buildStraightPinDiagram = viaShape((f, nm) => fastenerKindFor(f, nm) === 'pin', '5315');
const viaMore = (kind: string, fscs: string[]) => (entries: CharacteristicEntry[], o: ShapeOpts): string | null => {
  for (const f of fscs) {
    const r = resolveMore(entries, f, o.itemName);
    if (r?.shape && r.shape.kind === kind) return r.shape.draw(o);
  }
  return null;
};
export const buildShoulderDiagram = viaMore('shoulder', ['5305', '5306']);
export const buildExtendedWasherNutDiagram = viaMore('extnut', ['5310']);
export const buildQuickReleasePinDiagram = viaMore('qrpin', ['5315']);
export const buildCotterPinDiagram = viaMore('cotter', ['5315']);
export const buildElbowDiagram = viaMore('elbow', ['4730']);
export const buildStraightFittingDiagram = viaMore('straight', ['4730']);
export const buildHoseClampDiagram = viaMore('hoseclamp', ['4730', '5340']);
export const buildRivetDiagram = viaShape((f, nm) => fastenerKindFor(f, nm) === 'rivet', '5320');
export const buildBearingDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'bearing', '3110');
export const buildSealDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'seal', '5330');
export const buildGasketDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'gasket', '5330');
export const buildORingDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'oring', '5331');
export const buildPackingDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'packing', '5330');
export const buildFlatWasherDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'washer', '5310');
export const buildRingSpacerDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'spacer', '5365');
export const buildShimDiagram = viaShape((f, nm) => annulusKindFor(f, nm) === 'shim', '5365');
export const buildRetainingRingDiagram = viaShape((f, nm) => retainingKindFor(f, nm), '5325');
export const buildLoopClampDiagram = viaShape((f, nm) => loopKindFor(f, nm), '5340');
export const buildCompressionSpringDiagram = viaShape((f, nm) => springKindFor(f, nm) !== null, '5360');
export const buildKeyDiagram = viaShape((f, nm) => keyKindFor(f, nm), '5315');

// clip and arrow are re-exported for tests that build their own fixtures
export { clip, arrow };
