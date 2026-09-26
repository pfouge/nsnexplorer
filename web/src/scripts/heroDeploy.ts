// heroDeploy.ts — "global deployment" hero background: a slowly rotating
// orthographic globe, offset to the right, built from a geodesic dot
// lattice. Deployment missions fly great-circle routes between real US
// Army/Navy installations: ships crawl ocean-only lanes between Navy
// ports, flights never overfly the avoid zone (Russia/China), and every
// arrival lands with a pulse ring. Colors come from the design tokens at
// runtime so the scene re-themes with the light/dark toggle. Respects
// prefers-reduced-motion, pauses when the tab is hidden, caps DPR at 2.
import { LAND_DOTS, BASES, NAVY_COUNT, MASK_W, MASK_H, LAND_MASK, AVOID_MASK } from './landDots';

type Vec3 = [number, number, number];

interface Mission {
  a: Vec3; b: Vec3;          // unit vectors, earth coordinates
  omega: number;             // great-circle angle between a and b
  alt: number;               // altitude bump (fraction of radius)
  t0: number; dur: number;
  glyph: number;             // 0 part, 1 aircraft, 2 ship, 3 container, 4 component
  done: boolean;
}

const MAX_MISSIONS = 7;
const TILT = (22 * Math.PI) / 180;      // lean the pole toward the viewer
const REV_MS = 90_000;                  // one revolution per 90s
// Travel-time multiplier per asset: ships are far slower than flights.
const SPEED_MULT = [1.6, 1.0, 9.0, 2.8, 1.6];

// Normalized map coords (0..999) -> lon/lat degrees
const toLon = (nx: number): number => (nx / 999) * 348 - 168;
const toLat = (ny: number): number => 78 - (ny / 999) * 134;

const unit = (lonDeg: number, latDeg: number): Vec3 => {
  const lon = (lonDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const lonLatOf = (p: Vec3): [number, number] => [
  (Math.atan2(p[1], p[0]) * 180) / Math.PI,
  (Math.asin(Math.max(-1, Math.min(1, p[2]))) * 180) / Math.PI,
];

function init(): void {
  const wrap = document.querySelector<HTMLElement>('.hero-bg');
  const canvas = wrap?.querySelector<HTMLCanvasElement>('canvas');
  if (!wrap || !canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, DPR = 1;
  let GX = 0, GY = 0, R = 100;          // globe center + radius (px)
  let colors = {
    trail: '#55565C', accent: '#0E7C4D', sphere: '#F1ECE1',
    us: '#1D4AAE', ally: '#0A7191', foe: '#BE2F34',
  };
  let dotAlphaBase = 0.5; // light theme needs more ink than dark

  const readColors = () => {
    const s = getComputedStyle(document.documentElement);
    colors = {
      trail: s.getPropertyValue('--ink-soft').trim() || '#55565C',
      accent: s.getPropertyValue('--green').trim() || '#0E7C4D',
      sphere: s.getPropertyValue('--paper-2').trim() || '#F1ECE1',
      us: s.getPropertyValue('--geo-us').trim() || '#1D4AAE',
      ally: s.getPropertyValue('--geo-ally').trim() || '#0A7191',
      foe: s.getPropertyValue('--geo-foe').trim() || '#BE2F34',
    };
    dotAlphaBase = document.documentElement.dataset.theme === 'dark' ? 0.36 : 0.5;
  };

  const hexA = (hex: string, a: number): string => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  const resize = () => {
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = rect.width; H = rect.height;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Offset right; large enough to feel planetary, cropped by the hero.
    R = Math.min(H * 0.66, W * 0.30);
    GX = W * 0.74;
    GY = H * 0.52;
  };

  // Precompute unit vectors for the lattice, grouped by geopolitical
  // class (0 neutral, 1 US, 2 ally, 3 adversary) so each group renders
  // in one fillStyle pass.
  const dotGroups: Vec3[][] = [[], [], [], []];
  for (let i = 0; i < LAND_DOTS.length; i += 3) {
    dotGroups[LAND_DOTS[i + 2]].push(unit(toLon(LAND_DOTS[i]), toLat(LAND_DOTS[i + 1])));
  }
  const baseVecs: Vec3[] = BASES.map(([nx, ny]) => unit(toLon(nx), toLat(ny)));

  // Project an earth-coordinate point at rotation `rot`.
  // Returns [screenX, screenY, depth 0..1] or null when behind the limb.
  const project = (p: Vec3, rot: number, altScale = 1): [number, number, number] | null => {
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const u = (p[0] * cr - p[1] * sr) * altScale;
    const v = (p[0] * sr + p[1] * cr) * altScale;
    const w = p[2] * altScale;
    const ct = Math.cos(TILT), st = Math.sin(TILT);
    const u2 = u * ct + w * st;
    const w2 = -u * st + w * ct;
    if (u2 <= 0) return null;
    return [GX + R * v, GY - R * w2, u2];
  };

  // ---- Routing masks ----------------------------------------------------
  const decodeMask = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const landMask = decodeMask(LAND_MASK);
  const avoidMask = decodeMask(AVOID_MASK);
  const maskHitLonLat = (mask: Uint8Array, lon: number, lat: number): boolean => {
    if (lon > 180) lon -= 360;
    if (lon < -168 || lon > 180 || lat < -56 || lat > 78) return false;
    const gx = Math.min(MASK_W - 1, (((lon + 168) / 348) * MASK_W) | 0);
    const gy = Math.min(MASK_H - 1, (((78 - lat) / 134) * MASK_H) | 0);
    const idx = gy * MASK_W + gx;
    return ((mask[idx >> 3] >> (idx & 7)) & 1) === 1;
  };

  const slerp = (a: Vec3, b: Vec3, omega: number, t: number): Vec3 => {
    const so = Math.sin(omega);
    if (so < 1e-6) return a;
    const ka = Math.sin((1 - t) * omega) / so, kb = Math.sin(t * omega) / so;
    return [ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]];
  };

  // ---- Missions ---------------------------------------------------------
  const missions: Mission[] = [];
  const pulses: { p: Vec3; t0: number }[] = [];
  let rot = 0;

  const routeClear = (a: Vec3, b: Vec3, omega: number, mask: Uint8Array, endTol: number): boolean => {
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      if (t < endTol || t > 1 - endTol) continue;
      const [lon, lat] = lonLatOf(slerp(a, b, omega, t));
      if (maskHitLonLat(mask, lon, lat)) return false;
    }
    return true;
  };

  const spawn = (now: number, headStart = 0) => {
    const glyph = (Math.random() * 5) | 0;
    const isShip = glyph === 2;
    const pool = isShip ? NAVY_COUNT : BASES.length;
    for (let attempt = 0; attempt < 14; attempt++) {
      const i = (Math.random() * pool) | 0, j = (Math.random() * pool) | 0;
      if (i === j) continue;
      const a = baseVecs[i], b = baseVecs[j];
      // Prefer routes that start on the visible hemisphere.
      if (!project(a, rot)) continue;
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const omega = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (omega < 0.12) continue; // trivially short hop
      const ok = isShip
        ? routeClear(a, b, omega, landMask, 0.09)
        : routeClear(a, b, omega, avoidMask, 0.02);
      if (!ok) continue;
      const base = 2600 + omega * R * 14 + Math.random() * 1500;
      missions.push({
        a, b, omega,
        alt: isShip ? 0.004 : 0.045 + omega * 0.02,
        t0: now - headStart, dur: base * SPEED_MULT[glyph],
        glyph, done: false,
      });
      return;
    }
  };

  const drawGlyph = (kind: number, x: number, y: number, ang: number, s: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = colors.accent;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    switch (kind) {
      case 0: // hex part
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i - Math.PI / 6;
          const xx = Math.cos(a) * s, yy = Math.sin(a) * s;
          i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
        }
        ctx.closePath(); ctx.fill(); break;
      case 1: // aircraft: swept wings
        ctx.moveTo(s * 1.4, 0); ctx.lineTo(-s, s); ctx.lineTo(-s * 0.4, 0); ctx.lineTo(-s, -s);
        ctx.closePath(); ctx.fill(); break;
      case 2: // ship hull
        ctx.moveTo(-s * 1.2, -s * 0.5); ctx.lineTo(s * 1.2, -s * 0.5);
        ctx.lineTo(s * 0.6, s * 0.6); ctx.lineTo(-s * 0.6, s * 0.6);
        ctx.closePath(); ctx.fill(); break;
      case 3: // container
        ctx.rect(-s, -s * 0.65, s * 2, s * 1.3); ctx.fill(); break;
      default: // component ring
        ctx.arc(0, 0, s * 0.85, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };

  const frame = (now: number) => {
    ctx.clearRect(0, 0, W, H);

    // Sphere body: a soft disk so the globe reads as a solid.
    const grad = ctx.createRadialGradient(GX - R * 0.35, GY - R * 0.4, R * 0.1, GX, GY, R);
    grad.addColorStop(0, hexA(colors.sphere, 0.55));
    grad.addColorStop(1, hexA(colors.sphere, 0.18));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(GX, GY, R, 0, Math.PI * 2);
    ctx.fill();

    // Land lattice, one pass per geopolitical class
    const rDot = Math.max(1.25, R / 205);
    const groupColors = [colors.trail, colors.us, colors.ally, colors.foe];
    for (let g = 0; g < 4; g++) {
      ctx.fillStyle = groupColors[g];
      for (const p of dotGroups[g]) {
        const pr = project(p, rot);
        if (!pr) continue;
        const [x, y, d] = pr;
        const s = rDot * (0.45 + 0.75 * d);
        ctx.globalAlpha = dotAlphaBase + (0.98 - dotAlphaBase) * d;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    // Bases
    ctx.fillStyle = colors.accent;
    for (const p of baseVecs) {
      const pr = project(p, rot);
      if (!pr) continue;
      const [x, y, d] = pr;
      const s = rDot * 1.7 * (0.5 + 0.6 * d);
      ctx.globalAlpha = 0.45 + 0.5 * d;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }

    // Missions: trail + glyph, clipped to the visible hemisphere
    for (const m of missions) {
      const t = Math.min(1, (now - m.t0) / m.dur);
      const fade = t > 0.92 ? (1 - t) / 0.08 : 1;
      const tail = Math.max(0, t - 0.3);
      ctx.strokeStyle = colors.trail;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 4]);
      ctx.globalAlpha = 0.6 * fade;
      ctx.beginPath();
      let pen = false;
      const STEPS = 26;
      for (let i = 0; i <= STEPS; i++) {
        const tt = tail + ((t - tail) * i) / STEPS;
        const alt = 1 + m.alt * Math.sin(Math.PI * tt);
        const pr = project(slerp(m.a, m.b, m.omega, tt), rot, alt);
        if (!pr) { pen = false; continue; }
        if (pen) ctx.lineTo(pr[0], pr[1]);
        else { ctx.moveTo(pr[0], pr[1]); pen = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (t < 1) {
        const alt = 1 + m.alt * Math.sin(Math.PI * t);
        const head = project(slerp(m.a, m.b, m.omega, t), rot, alt);
        if (head) {
          const t2 = Math.min(1, t + 0.015);
          const alt2 = 1 + m.alt * Math.sin(Math.PI * t2);
          const ahead = project(slerp(m.a, m.b, m.omega, t2), rot, alt2);
          const ang = ahead ? Math.atan2(ahead[1] - head[1], ahead[0] - head[0]) : 0;
          ctx.globalAlpha = 0.95;
          drawGlyph(m.glyph, head[0], head[1], ang, Math.max(3, R / 90) * (0.6 + 0.4 * head[2]));
        }
      } else if (!m.done) {
        m.done = true;
        pulses.push({ p: m.b, t0: now });
      }
    }
    for (let i = missions.length - 1; i >= 0; i--) {
      if (now - missions[i].t0 > missions[i].dur) missions.splice(i, 1);
    }

    // Landing pulses
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i];
      const t = (now - pu.t0) / 1100;
      if (t >= 1) { pulses.splice(i, 1); continue; }
      const pr = project(pu.p, rot);
      if (!pr) continue;
      ctx.globalAlpha = 0.7 * (1 - t);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pr[0], pr[1], 2 + t * Math.max(12, R / 18), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (missions.length < MAX_MISSIONS && Math.random() < 0.02) spawn(now);
  };

  // ---- Boot ---------------------------------------------------------------
  readColors();
  resize();

  new ResizeObserver(() => { resize(); }).observe(wrap);

  if (reduced) {
    // Static scene: no rotation, three frozen mid-flight routes.
    const now = performance.now();
    spawn(now, 2600); spawn(now, 1800); spawn(now, 3400);
    frame(now + 0.001);
    new MutationObserver(() => { readColors(); frame(performance.now()); }).observe(
      document.documentElement, { attributes: true, attributeFilter: ['data-theme'] },
    );
    return;
  }

  new MutationObserver(() => { readColors(); }).observe(
    document.documentElement, { attributes: true, attributeFilter: ['data-theme'] },
  );

  const t0 = performance.now();
  spawn(t0, 2200); spawn(t0, 900); spawn(t0, 3100);

  let raf = 0;
  let last = t0;
  const loop = (now: number) => {
    rot += ((now - last) / REV_MS) * Math.PI * 2;
    last = now;
    frame(now);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { last = performance.now(); raf = requestAnimationFrame(loop); }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
