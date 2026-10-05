// NSN Explorer identity: single geometry source.
// Everything is built from one unit S (ring stroke = gap), circles and straight lines.
// Nothing here touches the disk: brand/build.mjs writes the site files from these functions.

export const INK = '#111114', PAPER = '#FAF8F3', GREEN = '#0E7C4D', GREEN_DK = '#1FB866';
export const S = 4; // one unit, in SVG user units
const f = (n) => Math.round(n * 1000) / 1000;
const rad = (d) => (d * Math.PI) / 180;
const poly = (pts) => 'M' + pts.map((p) => `${f(p[0])},${f(p[1])}`).join('L') + 'Z';
const circleCW = (r, cx = 0, cy = 0) => `M${f(cx - r)},${f(cy)}a${f(r)},${f(r)} 0 1,1 ${f(2 * r)},0a${f(r)},${f(r)} 0 1,1 ${f(-2 * r)},0Z`;
const circleCCW = (r, cx = 0, cy = 0) => `M${f(cx - r)},${f(cy)}a${f(r)},${f(r)} 0 1,0 ${f(2 * r)},0a${f(r)},${f(r)} 0 1,0 ${f(-2 * r)},0Z`;
const hexPts = (R) => Array.from({ length: 6 }, (_, k) => [R * Math.cos(rad(-90 + 60 * k)), R * Math.sin(rad(-90 + 60 * k))]);

/* ---------- the mark ----------
   full : apothem 4S, bore radius 3S (ring = S at the flats), needle tip at 2S (gap = S),
          needle = 60/120 rhombus tilted 30deg, so every edge is parallel to a flat of the nut;
          pivot hole radius S/3.
   small: for < 48 px. Ring 1.15S, bore 2.85S, needle tip at 2.2S, no pivot.            */
export function markSpec(small = false) {
  const apothem = 4 * S;
  const R = apothem / Math.cos(rad(30));
  const bore = small ? 2.85 * S : 3 * S;
  const L = small ? 2.2 * S : 2 * S; // needle half-length
  // rhombus with 30deg half-angle, rotated 30deg clockwise: vertical side edges at x = +-L/2
  const needlePts = [[L / 2, -L * Math.cos(rad(30))], [L / 2, L * Math.tan(rad(30)) / 2], [-L / 2, L * Math.cos(rad(30))], [-L / 2, -L * Math.tan(rad(30)) / 2]];
  return { apothem, R, bore, L, needlePts, pivot: small ? 0 : S / 3 };
}
export function markPaths(small = false) {
  const m = markSpec(small);
  return {
    nut: poly(hexPts(m.R)) + circleCCW(m.bore),
    needle: poly(m.needlePts) + (m.pivot ? circleCCW(m.pivot) : ''),
    w: 2 * m.apothem, h: 2 * m.R,
  };
}
// mark as an SVG group centred on 0,0
export function markG({ small = false, nut = 'currentColor', needle = 'currentColor' } = {}) {
  const p = markPaths(small);
  return `<path fill="${nut}" fill-rule="evenodd" d="${p.nut}"/><path fill="${needle}" fill-rule="evenodd" d="${p.needle}"/>`;
}

/* ---------- lettering ----------
   Caps drawn with the mark's stroke (t = 1 unit), cap height 6t, circles and straight lines,
   diagonals cut flat at cap height and baseline (no mitre spikes).                      */
const H = 6;
const rect = (x, y, w, h) => `M${f(x)},${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
function band(cx, cy, r, a0, a1) { // filled arc of stroke 1, angles clockwise in screen space
  const ro = r + 0.5, ri = r - 0.5, big = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const P = (rr, a) => `${f(cx + rr * Math.cos(rad(a)))},${f(cy + rr * Math.sin(rad(a)))}`;
  return `M${P(ro, a0)}A${ro},${ro} 0 ${big},1 ${P(ro, a1)}L${P(ri, a1)}A${ri},${ri} 0 ${big},0 ${P(ri, a0)}Z`;
}
function diagWidth(run) { let x = 1.2; for (let i = 0; i < 8; i++) x = Math.hypot(run - x, H) / H; return x; } // horizontal cut of a unit-thick diagonal
function diag(x0, y0, x1, y1, xw) { return poly([[x0, y0], [x0 + xw, y0], [x1 + xw, y1], [x1, y1]]); }
const bowl = (w, yTop, yBot) => { const r = (yBot - yTop) / 2, cx = w - 0.5 - r; return { r, cx, cy: yTop + r }; };

const G = {
  N: () => { const w = 4.9, x = diagWidth(w); return { w, d: rect(0, 0, 1, H) + rect(w - 1, 0, 1, H) + diag(0, 0, w - x, H, x) }; },
  S: () => { const r = 1.3, cx = 1.8; return { w: 3.6, d: band(cx, 0.4 + r, r, 90, 322) + band(cx, 5.6 - r, r, -90, 142) }; }, // 0.1 overshoot
  E: () => ({ w: 3.4, d: rect(0, 0, 1, H) + rect(0, 0, 3.4, 1) + rect(0, 2.5, 3.1, 1) + rect(0, 5, 3.4, 1) }),
  F: () => ({ w: 3.3, d: rect(0, 0, 1, H) + rect(0, 0, 3.3, 1) + rect(0, 2.6, 3.0, 1) }),
  X: () => { const w = 4.7, x = diagWidth(w); return { w, d: diag(0, 0, w - x, H, x) + diag(w - x, 0, 0, H, x) }; },
  P: () => { const w = 3.9, b = bowl(w, 0.5, 3.3); return { w, d: rect(0, 0, 1, H) + rect(0, 0, b.cx, 1) + rect(0, 2.8, b.cx, 1) + band(b.cx, b.cy, b.r, -90, 90) }; },
  R: () => { const w = 4.1, b = bowl(3.9, 0.5, 3.3), x = 1.32; return { w, d: rect(0, 0, 1, H) + rect(0, 0, b.cx, 1) + rect(0, 2.8, b.cx, 1) + band(b.cx, b.cy, b.r, -90, 90) + diag(b.cx - 0.55, 3.3, w - x, H, x) }; },
  B: () => { const w = 3.95, u = bowl(w - 0.3, 0.5, 2.8), l = bowl(w, 2.8, 5.5); return { w, d: rect(0, 0, 1, H) + rect(0, 0, u.cx, 1) + rect(0, 2.3, l.cx, 1) + rect(0, 5, l.cx, 1) + band(u.cx, u.cy, u.r, -90, 90) + band(l.cx, l.cy, l.r, -90, 90) }; },
  L: () => ({ w: 3.2, d: rect(0, 0, 1, H) + rect(0, 5, 3.2, 1) }),
  I: () => ({ w: 1, d: rect(0, 0, 1, H) }),
  O: () => ({ w: 6.2, d: circleCW(3.1, 3.1, 3) + circleCCW(2.1, 3.1, 3) }), // 0.1 overshoot
  C: () => ({ w: 5.35, d: band(3, 3, 2.5, 38, 322) }),
  U: () => { const w = 4.5, r = (w - 1) / 2; return { w, d: rect(0, 0, 1, H - 0.5 - r) + rect(w - 1, 0, 1, H - 0.5 - r) + band(w / 2, H - 0.5 - r, r, 0, 180) }; },
  ' ': () => ({ w: 3.2, d: '' }),
};
const KERN = { LO: -0.45, XP: -0.1, PL: -0.05, OR: -0.25, RE: -0.05, ER: 0, EX: -0.15, NS: -0.05, SN: -0.05, EF: 0, RC: -0.2, CE: -0.1, FR: -0.1, LI: -0.1, IC: -0.2, UB: 0, BL: -0.1, PU: -0.05 };
const TRACK = 0.95;
// returns { d, w } with glyph outlines laid on a straight baseline, cap box 0..6
export function line(text, track = TRACK) {
  let x = 0, d = '';
  const out = [];
  [...text].forEach((ch, i) => {
    const g = G[ch](); out.push({ ch, x, w: g.w, d: g.d });
    x += g.w; if (i < text.length - 1 && ch !== ' ' && text[i + 1] !== ' ') x += track + (KERN[ch + text[i + 1]] || 0);
  });
  return { glyphs: out, w: x, h: H };
}
const tr = (d, x, y = 0, k = 1) => (d ? `<path transform="translate(${f(x)} ${f(y)}) scale(${f(k)})" d="${d}"/>` : '');
export function lineG(text, { x = 0, y = 0, k = 1, fill = 'currentColor', track } = {}) {
  const l = line(text, track);
  return { w: l.w * k, h: H * k, svg: `<g fill="${fill}">${l.glyphs.map((g) => tr(g.d, x + g.x * k, y, k)).join('')}</g>` };
}
// lettering on a circle; side 'top' reads clockwise over the top, 'bottom' reads left to right under
export function arcG(text, { r, k = 1, side = 'top', fill = 'currentColor', track = 1.25 } = {}) {
  const l = line(text, track);
  const rBase = side === 'top' ? r : r + H * k; // baseline radius
  const total = (l.w * k) / (side === 'top' ? r + (H * k) / 2 : r + (H * k) / 2);
  let out = '';
  for (const g of l.glyphs) {
    if (!g.d) continue;
    const mid = ((g.x + g.w / 2) * k) / (r + (H * k) / 2) - total / 2; // radians from centre
    const deg = (mid * 180) / Math.PI;
    out += side === 'top'
      ? `<path transform="rotate(${f(deg)}) translate(${f((-g.w * k) / 2)} ${f(-r - H * k)}) scale(${f(k)})" d="${g.d}"/>`
      : `<path transform="rotate(${f(-deg)}) translate(${f((-g.w * k) / 2)} ${f(r)}) scale(${f(k)})" d="${g.d}"/>`;
  }
  return `<g fill="${fill}">${out}</g>`;
}

/* ---------- assemblies ---------- */
const svg = (vb, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(f).join(' ')}" ${extra}>${body}</svg>`;
const M = markPaths();
export const MARK_W = M.w, MARK_H = M.h;

export function markSvg(o = {}) { const pad = o.pad ?? 0; return svg([-MARK_W / 2 - pad, -MARK_H / 2 - pad, MARK_W + 2 * pad, MARK_H + 2 * pad], markG(o)); }

export const WORD_K = 0.8 * S; // lettering stroke in the lockups: 0.8 of the ring, so the mark stays the heaviest element
export function horizontal({ nut = 'currentColor', needle = 'currentColor', word = 'currentColor', small = false } = {}) {
  const k = WORD_K, gap = 2.5 * S;
  const a = lineG('NSN EXPLORER', { x: MARK_W + gap, y: -3 * k, k, fill: word });
  const W = MARK_W + gap + a.w;
  return { w: W, h: MARK_H, svg: svg([0, -MARK_H / 2, W, MARK_H], `<g transform="translate(${MARK_W / 2} 0)">${markG({ small, nut, needle })}</g>${a.svg}`) };
}
export function stacked({ nut = 'currentColor', needle = 'currentColor', word = 'currentColor' } = {}) {
  const k = S * 0.38, gap = 3 * S, track = 1.7;
  const W = line('NSN EXPLORER', track).w * k, y0 = MARK_H / 2 + gap;
  const a = lineG('NSN EXPLORER', { x: -W / 2, y: y0, k, fill: word, track });
  const Hh = MARK_H + gap + 6 * k;
  return { w: W, h: Hh, svg: svg([-W / 2, -MARK_H / 2, W, Hh], markG({ nut, needle }) + a.svg) };
}
export function tile({ size = 64, small = true, bg = INK, nut = PAPER, needle = GREEN_DK, radius = 0.19, fillRatio = 0.7 } = {}) {
  const k = (size * fillRatio) / MARK_H;
  return svg([0, 0, size, size], `<rect width="${size}" height="${size}" rx="${f(size * radius)}" fill="${bg}"/><g transform="translate(${size / 2} ${size / 2}) scale(${f(k)})">${markG({ small, nut, needle })}</g>`);
}
export function badge({ bg = INK, fg = PAPER, needle = GREEN_DK } = {}) {
  const Rb = 30 * S;          // outer radius
  const rIn = 17 * S;         // inner keyline radius (centre of stroke)
  const rOut = Rb - 2 * S;    // outer keyline radius; band between keylines = 11S - S
  const kTop = 0.8 * S, kBot = 0.55 * S;
  const mid = (rIn + rOut) / 2; // lettering is centred in the band
  const sep = (deg) => `<g transform="rotate(${deg}) translate(0 ${f(-mid)}) scale(0.9)"><path fill="${needle}" d="${poly(markSpec().needlePts)}"/></g>`;
  const body =
    `<circle r="${Rb}" fill="${bg}"/>` +
    `<circle r="${rOut}" fill="none" stroke="${fg}" stroke-width="${S}"/>` +
    `<circle r="${rIn}" fill="none" stroke="${fg}" stroke-width="${S}"/>` +
    arcG('NSN EXPLORER', { r: mid - 3 * kTop, k: kTop, side: 'top', fill: fg, track: 1.5 }) +
    arcG('FREE PUBLIC REFERENCE', { r: mid - 3 * kBot, k: kBot, side: 'bottom', fill: fg, track: 1.5 }) +
    sep(-90) + sep(90) +
    `<g transform="scale(2.5)">${markG({ nut: fg, needle })}</g>`;
  return svg([-Rb, -Rb, 2 * Rb, 2 * Rb], body);
}
