// diagram-r4.ts - round 4 drawing families, consulted by diagram.ts ONLY after every older builder has declined a
// part, so no existing drawing can change or disappear.
//
//   tee, cross                  tube / pipe tees and crosses (FSC 4730): ends numbered as the catalog numbers them (schematic)
//   nipple, union, reducer      two-ended pipe / tube fittings with a stated overall length (FSC 4730) (schematic)
//   plug                        threaded plug with a head (FSC 4730, 5365): thread size, overall length, head height
//   setscrew                    headless screw with a hex socket (FSC 5305)
//   roundnut                    plain or self-locking round nut (FSC 5310): outside diameter, thickness, thread size
//   blindnut                    blind-rivet nut (FSC 5310): body, head and length
//   selfalign                   self-aligning plain bearing (FSC 3120): outer member and inner member widths
//   spacerplate                 rectangular spacer plate (FSC 5365): length, width and (when stated) thickness
//   woodruff                    Woodruff key (FSC 5315): circle diameter, height, thickness
//
// Same rules as diagram-shapes.ts / diagram-more.ts: exact requirement names, null when an essential dimension is
// missing, nothing invented, the catalog's own number text on every dimension. A drawing that is not to scale says
// "SCHEMATIC, NOT TO SCALE" on the sheet. Pure string work.

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

export interface R4Opts {
  nsnDashed: string;
  itemName: string | null;
}
export interface R4Shape {
  kind: string;
  draw(o: R4Opts): string | null;
  thumb(): string | null;
}

const upper = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
const rootOf = (name: string | null | undefined) => upper(name).split(',')[0].trim();
const tokensOf = (name: string | null | undefined) => upper(name).split(/[,\s/]+/).filter(Boolean);
const SCHEMATIC = 'SCHEMATIC, NOT TO SCALE';

/**
 * One value that a requirement states exactly once. A plain value, or one whose only qualifier is in `allowed`
 * ("EXTERNAL INCHES 0.875"), is accepted; anything else (several entries, "FIRST END ...", a range with words) is not.
 */
function onceMeas(entries: CharacteristicEntry[], name: RegExp, allowed?: RegExp): Meas | null {
  const hits = entries.filter((e) => e.requirement && name.test(e.requirement));
  if (hits.length !== 1) return null;
  const m = parseMeasure(hits[0].reply);
  if (!m) return null;
  if (m.qualifier !== null && !(allowed && allowed.test(m.qualifier))) return null;
  return { ...m, qualifier: null };
}

const hasEntry = (entries: CharacteristicEntry[], name: RegExp) => entries.some((e) => e.requirement && name.test(e.requirement));

function hexPoints(cx: number, cy: number, across: number): string {
  const circ = across / 2 / Math.cos(Math.PI / 6);
  return [0, 60, 120, 180, 240, 300].map((d) => `${n(cx + circ * Math.cos((d * Math.PI) / 180))},${n(cy + circ * Math.sin((d * Math.PI) / 180))}`).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Tube / pipe fittings with 2, 3 or 4 ends (schematics)
// ---------------------------------------------------------------------------------------------
type FitKind = 'tee' | 'cross' | 'nipple' | 'union' | 'reducer';

interface FitModel {
  kind: FitKind;
  unit: Unit;
  ends: { labels: string[]; leg: Meas | null; sizeMid: number | null; sizeKind: string | null }[];
  overall: Meas | null;
  material: string | null;
}

export function fitKindFor(fsc: string, itemName: string | null): FitKind | null {
  if (fsc !== '4730') return null;
  const root = rootOf(itemName);
  if (root === 'TEE') return 'tee';
  if (root === 'CROSS') return 'cross';
  if (root === 'NIPPLE') return 'nipple';
  if (root === 'UNION') return 'union';
  if (root === 'REDUCER') return 'reducer';
  return null;
}

const ORDINALS = ['FIRST END', 'SECOND END', 'THIRD END', 'FOURTH END'];

/** A value stated per end ("FIRST END INCHES 1.562", "ALL ENDS INCHES 0.500"). An end with a conflicting or unreadable reply is null. */
function perEndN(entries: CharacteristicEntry[], name: RegExp, count: number): (Meas | null)[] {
  const found: (Meas | null)[] = Array.from({ length: count }, () => null);
  const bad: boolean[] = Array.from({ length: count }, () => false);
  const markAllBad = () => bad.fill(true);
  for (const e of entries) {
    if (!e.requirement || !name.test(e.requirement)) continue;
    const m = parseMeasure(e.reply);
    const q = m?.qualifier ?? null;
    let targets: number[] = [];
    if (q === 'ALL ENDS') targets = Array.from({ length: count }, (_, i) => i);
    else if (q) {
      const i = ORDINALS.indexOf(q);
      if (i >= 0 && i < count) targets = [i];
    }
    if (!m || targets.length === 0) {
      markAllBad();
      continue;
    }
    for (const t of targets) {
      const prev = found[t];
      if (prev && (prev.text !== m.text || prev.unit !== m.unit)) bad[t] = true;
      found[t] = { ...m, qualifier: null };
    }
  }
  return found.map((f, i) => (bad[i] ? null : f));
}

const END_SIZES: { name: RegExp; label: string; dia: boolean }[] = [
  { name: /^NOMINAL THREAD SIZE$/i, label: 'THREAD', dia: true },
  { name: /^NOMINAL OUTSIDE DIAMETER TUBE ACCOMMODATED$/i, label: 'TUBE OD', dia: true },
  { name: /^NOMINAL PIPE SIZE ACCOMMODATED$/i, label: 'PIPE', dia: false },
  { name: /^NOMINAL INSIDE DIAMETER HOSE ACCOMMODATED$/i, label: 'HOSE ID', dia: true },
];

export function fitModel(entries: CharacteristicEntry[], kind: FitKind): FitModel | null {
  const count = kind === 'tee' ? 3 : kind === 'cross' ? 4 : 2;
  const twoEnded = count === 2;
  const overall = twoEnded ? getMeas(entries, [/^NOMINAL OVERALL LENGTH$/i, /^OVERALL LENGTH$/i]) : null;
  const legs = twoEnded ? null : perEndN(entries, /^LEG LENGTH$/i, count);
  if (twoEnded && !overall) return null;
  if (legs && !legs.some(Boolean)) return null;
  const ends = Array.from({ length: count }, (_, i) => ({ labels: [] as string[], leg: legs ? legs[i] : null, sizeMid: null as number | null, sizeKind: null as string | null }));
  const ms: Meas[] = [];
  for (const s of END_SIZES) {
    const pe = perEndN(entries, s.name, count);
    pe.forEach((mm, i) => {
      if (!mm) return;
      ms.push(mm);
      ends[i].labels.push(`${s.label} ${s.dia ? '⌀' : ''}${mm.text}`);
      if (ends[i].sizeKind === null) {
        ends[i].sizeKind = s.label;
        ends[i].sizeMid = mm.mid;
      }
    });
  }
  if (legs) legs.forEach((l) => l && ms.push(l));
  if (overall) ms.push(overall);
  if (ends.every((e) => e.labels.length === 0)) return null;
  const unit = sharedUnit(...ms);
  if (!unit) return null;
  return { kind, unit, ends, overall, material: materialLabel(entries) };
}

const labelBlock = (x: number, y: number, labels: string[], anchor: 'start' | 'end' | 'middle'): string =>
  labels.slice(0, 3).map((t, i) => txt(x, y + i * 16, t, 'dg-dim', anchor)).join('');
const labelWidth = (labels: string[]) => Math.max(0, ...labels.slice(0, 3).map((t) => textWidth(t)));

function drawBranched(m: FitModel, o: R4Opts): string | null {
  const w = 22;
  const cross = m.kind === 'cross';
  const cx = 380;
  const cy = cross ? 250 : 200;
  const arm = 150;
  const vArm = cross ? 85 : 110;
  const [e1, e2, e3, e4] = m.ends;
  let body = txt(380, 56, SCHEMATIC, 'dg-label');
  const a = w / 2;
  const outline = cross
    ? [[cx - arm, cy - a], [cx - a, cy - a], [cx - a, cy - vArm], [cx + a, cy - vArm], [cx + a, cy - a], [cx + arm, cy - a], [cx + arm, cy + a], [cx + a, cy + a], [cx + a, cy + vArm], [cx - a, cy + vArm], [cx - a, cy + a], [cx - arm, cy + a]]
    : [[cx - arm, cy - a], [cx + arm, cy - a], [cx + arm, cy + a], [cx + a, cy + a], [cx + a, cy + vArm], [cx - a, cy + vArm], [cx - a, cy + a], [cx - arm, cy + a]];
  body += `<polygon points="${outline.map(([px, py]) => `${n(px)},${n(py)}`).join(' ')}" class="dg-edge"/>`;
  body += ln(cx - arm - 12, cy, cx + arm + 12, cy, 'dg-center') + ln(cx, cy - (cross ? vArm : 0) - 12, cx, cy + vArm + 12, 'dg-center');
  // ends are numbered as the catalog numbers them; where each end points is the drawing's choice
  body += txt(cx - arm - 14, cy - 24, 'END 1', 'dg-note', 'end') + labelBlock(cx - arm - 14, cy - 6, e1.labels, 'end');
  body += txt(cx + arm + 14, cy - 24, 'END 2', 'dg-note', 'start') + labelBlock(cx + arm + 14, cy - 6, e2.labels, 'start');
  body += txt(cx, cy + vArm + 36, 'END 3', 'dg-note', 'middle') + labelBlock(cx, cy + vArm + 52, e3.labels, 'middle');
  if (cross) body += txt(cx, cy - vArm - 78, 'END 4', 'dg-note', 'middle') + labelBlock(cx, cy - vArm - 62, e4.labels, 'middle');
  if (e1.leg) body += txt(cx - arm / 2 - w / 4, cy - w / 2 - 10, `${e1.leg.text} LEG LG`, 'dg-dim', 'middle');
  if (e2.leg) body += txt(cx + arm / 2 + w / 4, cy - w / 2 - 10, `${e2.leg.text} LEG LG`, 'dg-dim', 'middle');
  if (e3.leg) body += txt(cx + w / 2 + 10, cy + vArm * 0.7, `${e3.leg.text} LEG LG`, 'dg-dim', 'start');
  if (cross && e4.leg) body += txt(cx + w / 2 + 10, cy - vArm * 0.7, `${e4.leg.text} LEG LG`, 'dg-dim', 'start');
  const lastY = cy + vArm + 52 + (Math.min(3, e3.labels.length) - 1) * 16;
  if (lastY > BODY_BOTTOM - 4) return null;
  if (cx - arm - 14 - labelWidth(e1.labels) < 20 || cx + arm + 14 + labelWidth(e2.labels) > 742) return null;
  if (cross && cy - vArm - 62 < 66) return null;
  const missing = m.ends.map((e, i) => (e.labels.length === 0 ? i + 1 : 0)).filter(Boolean);
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? (cross ? 'CROSS' : 'TEE'), m.material],
    notes: [
      missing.length ? `NO SIZE STATED FOR END ${missing.join(', ')}` : 'SIZES ARE THE CATALOG VALUES FOR EACH END',
      'ENDS NUMBERED AS IN THE CATALOG, DIRECTIONS NOT STATED',
    ],
  });
}

function drawTwoEnded(m: FitModel, o: R4Opts): string | null {
  const w = 22;
  const x0 = 200;
  const x1 = 560;
  const cy = 200;
  const [a, b] = m.ends;
  let body = txt(380, 56, SCHEMATIC, 'dg-label');
  let note: string | null = null;
  if (m.kind === 'reducer') {
    // a larger end is drawn larger only when both ends state the same kind of size
    const comparable = a.sizeKind !== null && a.sizeKind === b.sizeKind && a.sizeMid !== null && b.sizeMid !== null && a.sizeMid !== b.sizeMid;
    const wa = comparable ? (a.sizeMid as number) > (b.sizeMid as number) ? 34 : 18 : w;
    const wb = comparable ? (a.sizeMid as number) > (b.sizeMid as number) ? 18 : 34 : w;
    if (!comparable) note = 'END SIZES NOT COMPARABLE, BODY SHOWN STRAIGHT';
    body += `<polygon points="${x0},${cy - wa / 2} ${x1},${cy - wb / 2} ${x1},${cy + wb / 2} ${x0},${cy + wa / 2}" class="dg-edge"/>`;
  } else {
    body += `<rect x="${x0}" y="${cy - w / 2}" width="${x1 - x0}" height="${w}" class="dg-edge"/>`;
    if (m.kind === 'union') body += `<rect x="${(x0 + x1) / 2 - 36}" y="${cy - w / 2 - 8}" width="72" height="${w + 16}" class="dg-edge"/>`;
  }
  body += ln(x0 - 14, cy, x1 + 14, cy, 'dg-center');
  body += dimH(x0, x1, cy + 56, cy + 17, cy + 17, `${(m.overall as Meas).text} OVERALL LG`, 'below');
  body += txt(x0 - 14, cy - 24, 'END 1', 'dg-note', 'end') + labelBlock(x0 - 14, cy - 6, a.labels, 'end');
  body += txt(x1 + 14, cy - 24, 'END 2', 'dg-note', 'start') + labelBlock(x1 + 14, cy - 6, b.labels, 'start');
  if (x0 - 14 - labelWidth(a.labels) < 20 || x1 + 14 + labelWidth(b.labels) > 742) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? m.kind.toUpperCase(), m.material],
    notes: [
      note,
      a.labels.length === 0 || b.labels.length === 0 ? 'AN END WITH NO SIZE STATED IS UNLABELLED' : 'SIZES ARE THE CATALOG VALUES FOR EACH END',
      m.kind === 'union' ? 'NUT AND SEAT NOT DRAWN' : m.kind === 'nipple' ? 'THREAD FORM NOT DRAWN' : 'END FORMS NOT DRAWN',
    ],
  });
}

function thumbFit(m: FitModel): string | null {
  if (m.kind === 'tee') return thumbWrap(`<polyline points="16,46 104,46" fill="none" stroke="var(--ink)" stroke-width="10"/><polyline points="60,46 60,100" fill="none" stroke="var(--ink)" stroke-width="10"/>`);
  if (m.kind === 'cross') return thumbWrap(`<polyline points="16,60 104,60" fill="none" stroke="var(--ink)" stroke-width="10"/><polyline points="60,16 60,104" fill="none" stroke="var(--ink)" stroke-width="10"/>`);
  if (m.kind === 'union') return thumbWrap(`<rect x="14" y="52" width="92" height="16" ${THUMB_STROKE}/><rect x="44" y="44" width="32" height="32" ${THUMB_STROKE}/>`);
  if (m.kind === 'reducer') return thumbWrap(`<polygon points="14,46 106,52 106,68 14,74" ${THUMB_STROKE}/>`);
  return thumbWrap(`<rect x="14" y="52" width="92" height="16" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Threaded plug with a head
// ---------------------------------------------------------------------------------------------
interface PlugModel {
  unit: Unit;
  thread: Meas;
  len: Meas;
  headH: Meas;
  headDia: Meas | null;
  threadLen: Meas | null;
  material: string | null;
}

export function plugKindFor(fsc: string, itemName: string | null): boolean {
  if (rootOf(itemName) !== 'PLUG') return false;
  const rest = tokensOf(itemName).slice(1);
  if (fsc === '5365') return rest[0] === 'MACHINE' && rest[1] === 'THREAD' && rest.length <= 3;
  if (fsc === '4730') return (rest.length === 1 && rest[0] === 'PIPE') || (rest[0] === 'TUBE' && rest[1] === 'FITTING') || (rest[0] === 'MACHINE' && rest[1] === 'THREAD');
  return false;
}

export function plugModel(entries: CharacteristicEntry[]): PlugModel | null {
  const EXT = /^EXTERNAL$/;
  const thread = onceMeas(entries, /^NOMINAL THREAD SIZE$/i, EXT);
  const len = onceMeas(entries, /^OVERALL LENGTH$/i);
  const headH = onceMeas(entries, /^HEAD HEIGHT$/i);
  if (!thread || !len || !headH) return null;
  const headDia = onceMeas(entries, /^HEAD DIAMETER$/i);
  const threadLen = onceMeas(entries, /^THREAD LENGTH$/i, EXT);
  const unit = sharedUnit(thread, len, headH, headDia ?? undefined, threadLen ?? undefined);
  if (!unit) return null;
  if (!(len.mid > headH.mid)) return null;
  if (headDia && !(headDia.mid >= thread.mid * 0.9)) return null;
  // a stated thread length longer than the shank is not drawn as given
  const tl = threadLen && threadLen.mid <= len.mid - headH.mid + 0.02 * len.mid ? threadLen : null;
  if (threadLen && !tl) return null;
  return { unit, thread, len, headH, headDia, threadLen: tl, material: materialLabel(entries) };
}

function drawPlug(m: PlugModel, o: R4Opts): string | null {
  const headW = m.headDia ? m.headDia.mid : m.thread.mid * 1.4;
  const sc = Math.min(300 / m.len.mid, 150 / headW);
  const L = m.len.mid * sc;
  const hh = m.headH.mid * sc;
  const hw = headW * sc;
  const dPx = Math.max(6, m.thread.mid * sc);
  if (!(L >= 30) || !(hh >= 6)) return null;
  const x0 = 250;
  const cy = 215;
  const xs = x0 + hh;
  const xe = x0 + L;
  const tlPx = m.threadLen ? Math.min(xe - xs, m.threadLen.mid * sc) : xe - xs;
  const body = `${txt(380, 52, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - hw / 2)}" width="${n(hh)}" height="${n(hw)}" class="dg-edge"/>
    <rect x="${n(xs)}" y="${n(cy - dPx / 2)}" width="${n(xe - xs)}" height="${n(dPx)}" class="dg-edge"/>
    <rect x="${n(xe - tlPx)}" y="${n(cy - dPx / 2)}" width="${n(tlPx)}" height="${n(dPx)}" class="dg-thread"/>
    ${ln(x0 - 14, cy, xe + 14, cy, 'dg-center')}
    ${dimH(x0, xe, cy + hw / 2 + 34, cy + hw / 2, cy + dPx / 2, `${m.len.text} OVERALL LG`, 'below')}
    ${dimH(x0, xs, cy - hw / 2 - 26, cy - hw / 2, cy - hw / 2, `${m.headH.text} HEAD H`, 'above', 'start', x0 - 2)}
    ${dimV(cy - dPx / 2, cy + dPx / 2, xe + 34, xe, xe, `⌀${m.thread.text} THREAD`, 'right')}
    ${m.headDia ? dimV(cy - hw / 2, cy + hw / 2, x0 - 34, x0, x0, `⌀${m.headDia.text} HEAD`, 'left') : ''}
    ${m.threadLen ? dimH(xe - tlPx, xe, cy - dPx / 2 - 22, cy - dPx / 2, cy - dPx / 2, `${m.threadLen.text} THREAD LG`, 'above', 'start', xe + 12) : ''}`;
  if (xe + 34 + 9 + textWidth(`⌀${m.thread.text} THREAD`) > 742 || x0 - 34 - 9 - textWidth(m.headDia ? `⌀${m.headDia.text} HEAD` : '') < 20) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'PLUG', m.material],
    notes: [m.headDia ? null : 'HEAD WIDTH NOT STATED, GENERIC', 'THREAD FORM AND TAPER NOT DRAWN', 'HEAD SHAPE, DRIVE NOT DRAWN'],
  });
}

function thumbPlug(m: PlugModel): string | null {
  const sc = Math.min(70 / m.len.mid, 60 / (m.headDia ? m.headDia.mid : m.thread.mid * 1.4));
  const L = Math.max(30, m.len.mid * sc);
  const hh = Math.max(6, m.headH.mid * sc);
  const hw = Math.max(16, (m.headDia ? m.headDia.mid : m.thread.mid * 1.4) * sc);
  const d = Math.max(6, m.thread.mid * sc);
  const x0 = 60 - L / 2;
  return thumbWrap(`<rect x="${n(x0)}" y="${n(60 - hw / 2)}" width="${n(hh)}" height="${n(hw)}" ${THUMB_STROKE}/><rect x="${n(x0 + hh)}" y="${n(60 - d / 2)}" width="${n(L - hh)}" height="${n(d)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Setscrew
// ---------------------------------------------------------------------------------------------
interface SetScrewModel {
  unit: Unit;
  dia: Meas;
  len: Meas;
  threadLen: Meas | null;
  socket: Meas | null;
  material: string | null;
}

export function setscrewKindFor(fsc: string, itemName: string | null): boolean {
  return fsc === '5305' && upper(itemName) === 'SETSCREW';
}

export function setscrewModel(entries: CharacteristicEntry[]): SetScrewModel | null {
  const dia = getMeas(entries, [/^NOMINAL THREAD DIAMETER$/i]);
  const len = getMeas(entries, [/^FASTENER LENGTH$/i]);
  if (!dia || !len) return null;
  const threadLen = getMeas(entries, [/^THREAD LENGTH$/i]);
  const socket = getMeas(entries, [/^WIDTH ACROSS FLATS$/i]);
  const unit = sharedUnit(dia, len, threadLen ?? undefined, socket ?? undefined);
  if (!unit) return null;
  if (!(len.mid > dia.mid * 0.5)) return null;
  // a hex socket wider than the screw, or a thread longer than the screw, is a misread: leave the part undrawn
  if (socket && !(socket.mid < dia.mid)) return null;
  if (threadLen && threadLen.mid > len.mid * 1.02) return null;
  return { unit, dia, len, threadLen, socket, material: materialLabel(entries) };
}

function drawSetScrew(m: SetScrewModel, o: R4Opts): string | null {
  const sc = Math.min(260 / m.len.mid, 190 / m.dia.mid);
  const Lpx = m.len.mid * sc;
  const Dpx = m.dia.mid * sc;
  if (!(Dpx >= 10) || !(Lpx >= 24)) return null;
  const ex = 120;
  const ey = 215;
  const R = 58;
  const x0 = 250;
  const xe = x0 + Lpx;
  // a thread shorter than the screw has no stated position along it, so it is only labelled, not drawn at one end
  const partial = !!m.threadLen && m.threadLen.mid < m.len.mid * 0.98;
  const tl = Lpx;
  const end = `${txt(ex, 62, 'END VIEW', 'dg-label')}
    <circle cx="${ex}" cy="${ey}" r="${R}" class="dg-edge"/>
    ${m.socket ? `<polygon points="${hexPoints(ex, ey, (m.socket.mid / m.dia.mid) * 2 * R)}" class="dg-edge"/>` : ''}
    ${ln(ex - R - 14, ey, ex + R + 14, ey, 'dg-center')}${ln(ex, ey - R - 14, ex, ey + R + 14, 'dg-center')}
    ${m.socket ? leader(ex + R * 0.2, ey + R * 0.2, ex - 60, ey + R + 40, 'HEX SOCKET', `${m.socket.text} A/F`) : ''}`;
  const side = `${txt(x0 + Lpx / 2, 62, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(ey - Dpx / 2)}" width="${n(Lpx)}" height="${n(Dpx)}" class="dg-edge"/>
    <rect x="${n(xe - tl)}" y="${n(ey - Dpx / 2)}" width="${n(tl)}" height="${n(Dpx)}" class="dg-thread"/>
    ${ln(x0 - 14, ey, xe + 14, ey, 'dg-center')}
    ${dimH(x0, xe, ey + Dpx / 2 + 34, ey + Dpx / 2, ey + Dpx / 2, `${m.len.text} LG`, 'below')}
    ${dimV(ey - Dpx / 2, ey + Dpx / 2, xe + 34, xe, xe, `⌀${m.dia.text} THREAD`, 'right')}
    ${partial ? txt(x0 + Lpx / 2, ey - Dpx / 2 - 18, `${(m.threadLen as Meas).text} THREAD LG`, 'dg-dim') : ''}`;
  if (xe + 34 + 9 + textWidth(`⌀${m.dia.text} THREAD`) > 742) return null;
  return frame(end + side, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'SETSCREW', m.material],
    notes: [m.socket ? null : 'SOCKET SIZE NOT STATED, NOT DRAWN', 'END VIEW ENLARGED, NOT TO SIDE VIEW SCALE', 'POINT STYLE NOT DRAWN', partial ? 'THREAD POSITION NOT STATED' : null],
  });
}

function thumbSetScrew(m: SetScrewModel): string | null {
  const sc = Math.min(96 / m.len.mid, 50 / m.dia.mid);
  const L = Math.max(24, m.len.mid * sc);
  const D = Math.max(8, m.dia.mid * sc);
  return thumbWrap(`<rect x="${n(60 - L / 2)}" y="${n(60 - D / 2)}" width="${n(L)}" height="${n(D)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Round nut and blind-rivet nut (FSC 5310)
// ---------------------------------------------------------------------------------------------
interface RoundNutModel {
  unit: Unit;
  thread: Meas;
  dia: Meas;
  thick: Meas;
  thickLabel: string;
  material: string | null;
  selfLocking: boolean;
}

export function roundNutKindFor(fsc: string, itemName: string | null): boolean {
  if (fsc !== '5310' || rootOf(itemName) !== 'NUT') return false;
  const rest = tokensOf(itemName).slice(1);
  return rest.length === 2 && (rest[0] === 'PLAIN' || rest[0] === 'SELF-LOCKING') && rest[1] === 'ROUND';
}

export function roundNutModel(entries: CharacteristicEntry[], itemName: string | null): RoundNutModel | null {
  const thread = getMeas(entries, [/^NOMINAL THREAD SIZE$/i]);
  const dia = getMeas(entries, [/^NUT DIAMETER$/i]);
  const hasT = hasEntry(entries, /^NUT THICKNESS$/i);
  const hasH = hasEntry(entries, /^NUT HEIGHT$/i);
  if (hasT && hasH) return null;
  const thick = getMeas(entries, [hasT ? /^NUT THICKNESS$/i : /^NUT HEIGHT$/i]);
  if (!thread || !dia || !thick) return null;
  const unit = sharedUnit(thread, dia, thick);
  if (!unit) return null;
  if (!(dia.mid > thread.mid * 1.05)) return null;
  return { unit, thread, dia, thick, thickLabel: hasT ? 'THICKNESS' : 'HEIGHT', material: materialLabel(entries), selfLocking: tokensOf(itemName)[1] === 'SELF-LOCKING' };
}

function drawRoundNut(m: RoundNutModel, o: R4Opts): string | null {
  const sc = Math.min(150 / m.dia.mid, 200 / m.thick.mid);
  const R = (m.dia.mid / 2) * sc;
  const tPx = m.thick.mid * sc;
  const bore = Math.max(2, (m.thread.mid / 2) * sc);
  if (!(R >= 20) || !(tPx >= 6)) return null;
  const cx = 190;
  const cy = 215;
  const x0 = 430;
  const body = `${txt(cx, 62, 'END VIEW', 'dg-label')}
    <circle cx="${cx}" cy="${cy}" r="${n(R)}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${n(bore)}" class="dg-edge"/>
    ${ln(cx - R - 14, cy, cx + R + 14, cy, 'dg-center')}${ln(cx, cy - R - 14, cx, cy + R + 14, 'dg-center')}
    ${leader(cx + R * 0.7, cy - R * 0.7, 270, cy - R - 26, 'NUT DIAMETER', `⌀${m.dia.text}`)}
    ${leader(cx + bore * 0.7, cy + bore * 0.7, 270, cy + R + 28, 'THREAD SIZE', `⌀${m.thread.text}`)}
    ${txt(x0 + tPx / 2, 62, 'SIDE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - R)}" width="${n(tPx)}" height="${n(2 * R)}" class="dg-edge"/>
    ${ln(x0 - 14, cy, x0 + tPx + 14, cy, 'dg-center')}
    ${dimH(x0, x0 + tPx, cy + R + 28, cy + R, cy + R, `${m.thick.text} ${m.thickLabel}`, 'below', 'start', x0 - 2)}`;
  if (x0 + textWidth(`${m.thick.text} ${m.thickLabel}`) > 742) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'NUT, ROUND', m.material],
    notes: ['THREAD, DRIVE NOTCHES AND HOLES NOT DRAWN', m.selfLocking ? 'LOCKING ELEMENT NOT DRAWN' : null],
  });
}

function thumbRoundNut(m: RoundNutModel): string | null {
  const R = 40;
  const bore = Math.max(6, (m.thread.mid / m.dia.mid) * R);
  return thumbWrap(`${thumbCircle(60, 60, R)}${thumbCircle(60, 60, bore)}`);
}

interface BlindNutModel {
  unit: Unit;
  thread: Meas;
  dia: Meas;
  len: Meas;
  headDia: Meas;
  headH: Meas;
  material: string | null;
}

export function blindNutKindFor(fsc: string, itemName: string | null): boolean {
  if (fsc !== '5310' || rootOf(itemName) !== 'NUT') return false;
  const rest = tokensOf(itemName).slice(1);
  return rest.length === 3 && (rest[0] === 'PLAIN' || rest[0] === 'SELF-LOCKING') && rest[1] === 'BLIND' && rest[2] === 'RIVET';
}

export function blindNutModel(entries: CharacteristicEntry[]): BlindNutModel | null {
  const thread = getMeas(entries, [/^NOMINAL THREAD SIZE$/i]);
  const dia = getMeas(entries, [/^NUT DIAMETER$/i]);
  const len = getMeas(entries, [/^NUT LENGTH$/i]);
  const headDia = getMeas(entries, [/^HEAD DIAMETER$/i]);
  const headH = getMeas(entries, [/^HEAD HEIGHT$/i]);
  if (!thread || !dia || !len || !headDia || !headH) return null;
  const unit = sharedUnit(thread, dia, len, headDia, headH);
  if (!unit) return null;
  if (!(headDia.mid > dia.mid) || !(dia.mid > thread.mid * 0.8) || !(len.mid > headH.mid * 1.5)) return null;
  return { unit, thread, dia, len, headDia, headH, material: materialLabel(entries) };
}

function drawBlindNut(m: BlindNutModel, o: R4Opts): string | null {
  const sc = Math.min(330 / m.len.mid, 150 / m.headDia.mid);
  const Lpx = m.len.mid * sc;
  const hh = Math.max(3, m.headH.mid * sc);
  const hr = (m.headDia.mid / 2) * sc;
  const br = (m.dia.mid / 2) * sc;
  const tr = Math.max(1.5, (m.thread.mid / 2) * sc);
  if (!(Lpx >= 30) || !(br >= 6)) return null;
  const x0 = 300;
  const cy = 215;
  const xe = x0 + Lpx;
  const body = `${txt(380, 52, 'SECTION', 'dg-label')}
    <rect x="${n(x0)}" y="${n(cy - hr)}" width="${n(hh)}" height="${n(2 * hr)}" class="dg-edge"/>
    <rect x="${n(x0 + hh)}" y="${n(cy - br)}" width="${n(Lpx - hh)}" height="${n(2 * br)}" class="dg-edge"/>
    <line x1="${n(x0)}" y1="${n(cy - tr)}" x2="${n(xe)}" y2="${n(cy - tr)}" class="dg-hidden"/>
    <line x1="${n(x0)}" y1="${n(cy + tr)}" x2="${n(xe)}" y2="${n(cy + tr)}" class="dg-hidden"/>
    ${ln(x0 - 14, cy, xe + 14, cy, 'dg-center')}
    ${dimH(x0, xe, cy + hr + 34, cy + hr, cy + br, `${m.len.text} NUT LG`, 'below')}
    ${dimH(x0, x0 + hh, cy - hr - 26, cy - hr, cy - hr, `${m.headH.text} HEAD H`, 'above', 'start', x0 - 2)}
    ${dimV(cy - hr, cy + hr, x0 - 34, x0, x0, `⌀${m.headDia.text} HEAD`, 'left')}
    ${dimV(cy - br, cy + br, xe + 34, xe, xe, `⌀${m.dia.text} BODY`, 'right')}
    ${leader(x0 + Lpx * 0.45, cy - tr, x0 + Lpx * 0.45 + 20, cy - br - 62, 'THREAD SIZE', `⌀${m.thread.text}`)}`;
  if (xe + 34 + 9 + textWidth(`⌀${m.dia.text} BODY`) > 742 || x0 - 34 - 9 - textWidth(`⌀${m.headDia.text} HEAD`) < 20) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'NUT, BLIND RIVET', m.material],
    notes: ['THREAD, KNURL AND CLOSED OR OPEN END NOT DRAWN', 'BORE SHOWN AT THE THREAD SIZE'],
  });
}

function thumbBlindNut(m: BlindNutModel): string | null {
  const sc = Math.min(80 / m.len.mid, 56 / m.headDia.mid);
  const L = m.len.mid * sc;
  const hh = Math.max(4, m.headH.mid * sc);
  const hr = (m.headDia.mid / 2) * sc;
  const br = Math.max(4, (m.dia.mid / 2) * sc);
  const x0 = 60 - L / 2;
  return thumbWrap(`<rect x="${n(x0)}" y="${n(60 - hr)}" width="${n(hh)}" height="${n(2 * hr)}" ${THUMB_STROKE}/><rect x="${n(x0 + hh)}" y="${n(60 - br)}" width="${n(L - hh)}" height="${n(2 * br)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Self-aligning plain bearing (FSC 3120)
// ---------------------------------------------------------------------------------------------
interface SelfAlignModel {
  unit: Unit;
  bore: Meas;
  od: Meas;
  outerW: Meas;
  innerW: Meas;
  material: string | null;
}

export function selfAlignKindFor(fsc: string, itemName: string | null): boolean {
  if (fsc !== '3120') return false;
  const t = upper(itemName);
  return t === 'BEARING,PLAIN,SELF-ALIGNING' || t === 'BEARING,PLAIN,SPHERICAL';
}

export function selfAlignModel(entries: CharacteristicEntry[]): SelfAlignModel | null {
  const bore = getMeas(entries, [/^BORE DIAMETER$/i]);
  const od = getMeas(entries, [/^OUTER MEMBER OUTSIDE DIAMETER$/i]);
  const outerW = getMeas(entries, [/^OUTER MEMBER WIDTH$/i]);
  const innerW = getMeas(entries, [/^INNER MEMBER WIDTH$/i]);
  if (!bore || !od || !outerW || !innerW) return null;
  const unit = sharedUnit(bore, od, outerW, innerW);
  if (!unit) return null;
  if (!(od.mid > bore.mid * 1.05)) return null;
  // a body with a shank, rod, flange or bore step is a different part from the plain two-member bearing drawn here
  if (hasEntry(entries, /^(?:SHANK|OVERALL LENGTH|BODY (?:INSIDE|OUTSIDE) DIAMETER|SPHERICAL BODY DIAMETER|FLANGE|THREAD)/i)) return null;
  return { unit, bore, od, outerW, innerW, material: materialLabel(entries) };
}

function drawSelfAlign(m: SelfAlignModel, o: R4Opts): string | null {
  const widest = Math.max(m.outerW.mid, m.innerW.mid);
  const sc = Math.min(150 / m.od.mid, 190 / widest);
  const R = (m.od.mid / 2) * sc;
  const rb = Math.max(3, (m.bore.mid / 2) * sc);
  const wo = m.outerW.mid * sc;
  const wi = m.innerW.mid * sc;
  if (!(R >= 20) || !(wo >= 6) || !(wi >= 6)) return null;
  const cx = 140;
  const cy = 215;
    // the inner member's outside size is not stated: it is drawn generic, midway between bore and outer member
  const rInner = (rb + R) / 2;
  const xc = 520;
  const body = `${txt(cx, 62, 'END VIEW', 'dg-label')}
    <circle cx="${cx}" cy="${cy}" r="${n(R)}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${n(rb)}" class="dg-edge"/>
    ${ln(cx - R - 14, cy, cx + R + 14, cy, 'dg-center')}${ln(cx, cy - R - 14, cx, cy + R + 14, 'dg-center')}
    ${leader(cx + R * 0.7, cy - R * 0.7, 230, cy - R - 26, 'OUTER MEMBER OUTSIDE DIA', `⌀${m.od.text}`)}
    ${leader(cx + rb * 0.7, cy + rb * 0.7, 230, cy + R + 28, 'BORE', `⌀${m.bore.text}`)}
    ${txt(xc, 62, 'SECTION', 'dg-label')}
    <rect x="${n(xc - wo / 2)}" y="${n(cy - R)}" width="${n(wo)}" height="${n(R - rInner)}" class="dg-sec"/>
    <rect x="${n(xc - wo / 2)}" y="${n(cy + rInner)}" width="${n(wo)}" height="${n(R - rInner)}" class="dg-sec"/>
    <rect x="${n(xc - wi / 2)}" y="${n(cy - rInner)}" width="${n(wi)}" height="${n(rInner - rb)}" class="dg-sec"/>
    <rect x="${n(xc - wi / 2)}" y="${n(cy + rb)}" width="${n(wi)}" height="${n(rInner - rb)}" class="dg-sec"/>
    ${ln(xc - Math.max(wo, wi) / 2 - 14, cy, xc + Math.max(wo, wi) / 2 + 14, cy, 'dg-center')}
    ${dimH(xc - wo / 2, xc + wo / 2, cy - R - 30, cy - R, cy - R, `${m.outerW.text} OUTER MEMBER WIDTH`, 'above')}
    ${dimH(xc - wi / 2, xc + wi / 2, cy + R + 30, cy + rInner, cy + rInner, `${m.innerW.text} INNER MEMBER WIDTH`, 'below')}`;
  if (xc + Math.max(textWidth(`${m.outerW.text} OUTER MEMBER WIDTH`), textWidth(`${m.innerW.text} INNER MEMBER WIDTH`)) / 2 > 735) return null;
  if (cy + R + 30 + 24 > BODY_BOTTOM) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'BEARING, PLAIN, SELF-ALIGNING', m.material],
    notes: ['INNER MEMBER OUTSIDE SIZE AND SPHERICAL SEAT NOT STATED, SHOWN GENERIC'],
  });
}

function thumbSelfAlign(m: SelfAlignModel): string | null {
  const rb = Math.max(8, 38 * (m.bore.mid / m.od.mid));
  return thumbWrap(`${thumbCircle(60, 60, 42)}${thumbCircle(60, 60, (42 + rb) / 2)}${thumbCircle(60, 60, rb)}`);
}

// ---------------------------------------------------------------------------------------------
// Rectangular spacer plate (FSC 5365)
// ---------------------------------------------------------------------------------------------
interface PlateModel {
  unit: Unit;
  len: Meas;
  width: Meas;
  thick: Meas | null;
  material: string | null;
  features: string[];
}

export function plateKindFor(fsc: string, itemName: string | null): boolean {
  return fsc === '5365' && upper(itemName) === 'SPACER,PLATE';
}

export function plateModel(entries: CharacteristicEntry[]): PlateModel | null {
  const len = getMeas(entries, [/^OVERALL LENGTH$/i]);
  const width = getMeas(entries, [/^OVERALL WIDTH$/i]);
  if (!len || !width) return null;
  const thick = getMeas(entries, [/^OVERALL THICKNESS$/i]);
  const unit = sharedUnit(len, width, thick ?? undefined);
  if (!unit) return null;
  const features: string[] = [];
  if (hasEntry(entries, /^(?:BOLT )?HOLE (?:DIAMETER|QUANTITY)$|^BOLT HOLE/i)) features.push('HOLES');
  if (hasEntry(entries, /^APERTURE/i)) features.push('APERTURE');
  if (hasEntry(entries, /CORNER (?:BEVEL|RADIUS)/i)) features.push('CORNER BEVELS');
  return { unit, len, width, thick, material: materialLabel(entries), features };
}

function drawPlate(m: PlateModel, o: R4Opts): string | null {
  const longSide = Math.max(m.len.mid, m.width.mid);
  const sc = Math.min(340 / m.len.mid, (m.thick ? 120 : 190) / m.width.mid, 340 / longSide);
  const Lpx = m.len.mid * sc;
  const Wpx = m.width.mid * sc;
  if (!(Wpx >= 8) || !(Lpx >= 8)) return null;
  const x0 = 200;
  const y0 = 120;
  const cx = x0 + Lpx / 2;
  let body = `${txt(x0 + Lpx / 2, 62, 'PLAN VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(y0)}" width="${n(Lpx)}" height="${n(Wpx)}" class="dg-edge"/>
    ${dimH(x0, x0 + Lpx, y0 + Wpx + 34, y0 + Wpx, y0 + Wpx, `${m.len.text} LG`, 'below')}
    ${dimV(y0, y0 + Wpx, x0 + Lpx + 34, x0 + Lpx, x0 + Lpx, `${m.width.text} W`, 'right')}`;
  if (x0 + Lpx + 34 + 9 + textWidth(`${m.width.text} W`) > 742) return null;
  if (m.thick) {
    const tPx = Math.max(3, m.thick.mid * sc);
    const sy = y0 + Wpx + 100;
    if (sy + tPx + 40 > BODY_BOTTOM) return null;
    body += `${txt(cx, sy - 14, 'EDGE VIEW', 'dg-label')}
      <rect x="${n(x0)}" y="${n(sy)}" width="${n(Lpx)}" height="${n(tPx)}" class="dg-edge"/>
      ${dimV(sy, sy + tPx, x0 + Lpx + 34, x0 + Lpx, x0 + Lpx, `${m.thick.text} THK`, 'right')}`;
  }
  if (y0 + Wpx + 34 + 24 > BODY_BOTTOM) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'SPACER, PLATE', m.material],
    notes: [m.features.length ? `NOT DRAWN: ${m.features.join(', ')}` : null, m.thick ? null : 'THICKNESS NOT STATED'],
  });
}

function thumbPlate(m: PlateModel): string | null {
  const sc = Math.min(96 / m.len.mid, 70 / m.width.mid);
  const L = Math.max(10, m.len.mid * sc);
  const W = Math.max(8, m.width.mid * sc);
  return thumbWrap(`<rect x="${n(60 - L / 2)}" y="${n(60 - W / 2)}" width="${n(L)}" height="${n(W)}" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Woodruff key (FSC 5315)
// ---------------------------------------------------------------------------------------------
interface WoodruffModel {
  unit: Unit;
  dia: Meas;
  height: Meas;
  thick: Meas;
  designation: string | null;
  material: string | null;
}

export function woodruffKindFor(fsc: string, itemName: string | null): boolean {
  return fsc === '5315' && upper(itemName) === 'KEY,WOODRUFF';
}

export function woodruffModel(entries: CharacteristicEntry[]): WoodruffModel | null {
  const dia = getMeas(entries, [/^CIRCLE DIAMETER$/i]);
  const height = getMeas(entries, [/^KEY HEIGHT$/i]);
  const thick = getMeas(entries, [/^THICKNESS$/i]);
  if (!dia || !height || !thick) return null;
  const unit = sharedUnit(dia, height, thick);
  if (!unit) return null;
  // the key is a circular segment: its height lies between a third of the circle and the full circle
  if (!(height.mid > dia.mid * 0.3) || !(height.mid <= dia.mid * 1.02)) return null;
  const des = entries.find((e) => e.requirement && /^KEY SIZE DESIGNATION$/i.test(e.requirement))?.reply ?? null;
  return { unit, dia, height, thick, designation: des && /^WOODRUFF [0-9A-Z]{1,4}$/i.test(des.trim()) ? des.trim().toUpperCase() : null, material: materialLabel(entries) };
}

function drawWoodruff(m: WoodruffModel, o: R4Opts): string | null {
  const sc = Math.min(210 / m.dia.mid, 220 / m.height.mid);
  const R = (m.dia.mid / 2) * sc;
  const h = Math.min(m.height.mid * sc, 2 * R);
  const tPx = Math.max(3, m.thick.mid * sc);
  if (!(R >= 20)) return null;
  const cx = 170;
  const flatY = 150;
  // circle of diameter D, cut by a chord: the segment of the given height hangs below the flat
  const cyc = flatY + h - R; // circle centre
  const half = Math.sqrt(Math.max(0, R * R - (cyc - flatY) * (cyc - flatY)));
  const large = h > R ? 1 : 0;
  const arc = `M ${n(cx - half)} ${n(flatY)} A ${n(R)} ${n(R)} 0 ${large} 0 ${n(cx + half)} ${n(flatY)} Z`;
  const x0 = 500;
  const side = `${txt(x0 + tPx / 2, 62, 'EDGE VIEW', 'dg-label')}
    <rect x="${n(x0)}" y="${n(flatY)}" width="${n(tPx)}" height="${n(h)}" class="dg-edge"/>
    ${dimH(x0, x0 + tPx, flatY - 26, flatY, flatY, `${m.thick.text} THK`, 'above', 'start', x0 - 2)}`;
  const body = `${txt(cx, 62, 'SIDE VIEW', 'dg-label')}
    <path d="${arc}" class="dg-edge"/>
    ${dimV(flatY, flatY + h, cx + R + 34, cx + half, cx + half, `${m.height.text} HEIGHT`, 'right')}
    ${dimH(cx - R, cx + R, flatY + h + 40, cyc, cyc, `⌀${m.dia.text} CIRCLE`, 'below')}${side}`;
  if (flatY + h + 40 + 24 > BODY_BOTTOM || cx + R + 34 + 9 + textWidth(`${m.height.text} HEIGHT`) > x0 - 14) return null;
  return frame(body, {
    nsnDashed: o.nsnDashed,
    unit: m.unit,
    items: [o.itemName ?? 'KEY, WOODRUFF', m.designation, m.material],
    notes: ['EDGE CHAMFER OR RADIUS AND FLAT TRIM NOT DRAWN'],
  });
}

function thumbWoodruff(m: WoodruffModel): string | null {
  const R = 40;
  const h = Math.min(2 * R, (m.height.mid / m.dia.mid) * 2 * R);
  const cy0 = 30 + h - R;
  const half = Math.sqrt(Math.max(0, R * R - (cy0 - 30) * (cy0 - 30)));
  return thumbWrap(`<path d="M ${n(60 - half)} 30 A ${R} ${R} 0 ${h > R ? 1 : 0} 0 ${n(60 + half)} 30 Z" ${THUMB_STROKE}/>`);
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------
export function resolveR4(entries: CharacteristicEntry[], fsc: string, itemName: string | null): R4Shape | null {
  const fk = fitKindFor(fsc, itemName);
  if (fk) {
    const m = fitModel(entries, fk);
    if (!m) return null;
    const branched = fk === 'tee' || fk === 'cross';
    return { kind: fk, draw: (o) => (branched ? drawBranched(m, o) : drawTwoEnded(m, o)), thumb: () => thumbFit(m) };
  }
  if (plugKindFor(fsc, itemName)) {
    const m = plugModel(entries);
    return m ? { kind: 'plug', draw: (o) => drawPlug(m, o), thumb: () => thumbPlug(m) } : null;
  }
  if (setscrewKindFor(fsc, itemName)) {
    const m = setscrewModel(entries);
    return m ? { kind: 'setscrew', draw: (o) => drawSetScrew(m, o), thumb: () => thumbSetScrew(m) } : null;
  }
  if (roundNutKindFor(fsc, itemName)) {
    const m = roundNutModel(entries, itemName);
    return m ? { kind: 'roundnut', draw: (o) => drawRoundNut(m, o), thumb: () => thumbRoundNut(m) } : null;
  }
  if (blindNutKindFor(fsc, itemName)) {
    const m = blindNutModel(entries);
    return m ? { kind: 'blindnut', draw: (o) => drawBlindNut(m, o), thumb: () => thumbBlindNut(m) } : null;
  }
  if (selfAlignKindFor(fsc, itemName)) {
    const m = selfAlignModel(entries);
    return m ? { kind: 'selfalign', draw: (o) => drawSelfAlign(m, o), thumb: () => thumbSelfAlign(m) } : null;
  }
  if (plateKindFor(fsc, itemName)) {
    const m = plateModel(entries);
    return m ? { kind: 'spacerplate', draw: (o) => drawPlate(m, o), thumb: () => thumbPlate(m) } : null;
  }
  if (woodruffKindFor(fsc, itemName)) {
    const m = woodruffModel(entries);
    return m ? { kind: 'woodruff', draw: (o) => drawWoodruff(m, o), thumb: () => thumbWoodruff(m) } : null;
  }
  return null;
}

/** For the coverage script: the part's R4 drawing when it is of the given kind, else null. */
export const viaR4 = (kind: string, fscs: string[]) => (entries: CharacteristicEntry[], o: R4Opts): string | null => {
  for (const f of fscs) {
    const r = resolveR4(entries, f, o.itemName);
    if (r && r.kind === kind) return r.draw(o);
  }
  return null;
};

// Named builders for the coverage script and tests (same signature as the older ones).
export const buildR4TeeDiagram = viaR4('tee', ['4730']);
export const buildR4CrossDiagram = viaR4('cross', ['4730']);
export const buildR4NippleDiagram = viaR4('nipple', ['4730']);
export const buildR4UnionDiagram = viaR4('union', ['4730']);
export const buildR4ReducerDiagram = viaR4('reducer', ['4730']);
export const buildR4PlugDiagram = viaR4('plug', ['4730', '5365']);
export const buildR4SetscrewDiagram = viaR4('setscrew', ['5305']);
export const buildR4RoundNutDiagram = viaR4('roundnut', ['5310']);
export const buildR4BlindNutDiagram = viaR4('blindnut', ['5310']);
export const buildR4SelfAlignDiagram = viaR4('selfalign', ['3120']);
export const buildR4SpacerPlateDiagram = viaR4('spacerplate', ['5365']);
export const buildR4WoodruffDiagram = viaR4('woodruff', ['5315']);

/** The part's r4 shape (a cheap name check first), or null. */
export function r4ShapeFor(entries: CharacteristicEntry[], fsc: string, itemName: string | null): R4Shape | null {
  return resolveR4(entries, fsc, itemName);
}
