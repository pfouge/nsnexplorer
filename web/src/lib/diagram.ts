// diagram.ts — build-time engineering-drawing SVG generator.
//
// Draws a two-view dimensioned drawing (plan view + enlarged section) for
// ring-shaped parts (o-rings, packings, gaskets) from the FLIS
// characteristics already stored on the NSN: outside/inside diameter,
// cross-section, material, hardness, temperature rating. Pure string
// generation at build time — no AI, no network, no runtime cost — and the
// SVG inherits the page's CSS variables so it renders natively in both
// themes.
//
// Returns null when the characteristics don't carry enough geometry;
// callers simply omit the section.

import type { CharacteristicEntry } from './data';

interface Dim {
  min: number;
  max: number;
  mid: number;
  text: string; // as printed on the drawing, e.g. "Ø4.226–4.298"
}

/** Parses '4.226-4.298 INCHES' | '0.301 INCHES' | '75.0 SHORE...' -> Dim. */
function parseInches(reply: string | null): Dim | null {
  if (!reply) return null;
  const m = reply.match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*INCHES/i);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] ? Number(m[2]) : min;
  if (!(min > 0) || !(max >= min)) return null;
  const fmt = (n: number) => n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');
  return {
    min,
    max,
    mid: (min + max) / 2,
    text: min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`,
  };
}

const pick = (
  entries: CharacteristicEntry[],
  mrcs: string[],
  reqPattern?: RegExp
): CharacteristicEntry | undefined =>
  entries.find((e) => (e.mrc && mrcs.includes(e.mrc)) || (reqPattern && e.requirement && reqPattern.test(e.requirement)));

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Detects the linear unit the FLIS characteristics are expressed in, so
 * the drawing can label it instead of assuming inches. Returns a short
 * label ('INCHES', 'MM', 'CM') and a compact suffix ('IN', 'MM', 'CM').
 */
function detectUnit(entries: CharacteristicEntry[]): { long: string; short: string } {
  const blob = entries.map((e) => (e.reply || '').toUpperCase()).join(' ');
  if (/\bMILLIMET(?:ER|RE)S?\b|\bMM\b/.test(blob)) return { long: 'MILLIMETERS', short: 'MM' };
  if (/\bCENTIMET(?:ER|RE)S?\b|\bCM\b/.test(blob)) return { long: 'CENTIMETERS', short: 'CM' };
  return { long: 'INCHES', short: 'IN' };
}

/**
 * Ring-part drawing. Needs at least a cross-section plus one of OD/ID
 * (the third is derived: OD = ID + 2·CS).
 */
export function buildRingDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const odE = pick(entries, ['ABHE'], /\bOUTSIDE DIAMETER\b|\bOUTER DIAMETER\b|\bOD\b/i);
  const idE = pick(entries, ['ADYT', 'ABHP'], /(CENTER HOLE|INSIDE|INNER) DIAMETER|\bID\b|\bBORE\b/i);
  const csE = pick(entries, ['ADVN', 'ABKW'], /CROSS[- ]SECTION|SECTION DIAMETER/i);

  const od0 = parseInches(odE?.reply ?? null);
  const id0 = parseInches(idE?.reply ?? null);
  const cs = parseInches(csE?.reply ?? null);
  if (!cs || (!od0 && !id0)) return null;

  const od: Dim = od0 ?? {
    min: id0!.min + 2 * cs.min,
    max: id0!.max + 2 * cs.max,
    mid: id0!.mid + 2 * cs.mid,
    text: `≈${(id0!.mid + 2 * cs.mid).toFixed(3)} (ref)`,
  };
  const id: Dim = id0 ?? {
    min: Math.max(0, od0!.min - 2 * cs.max),
    max: Math.max(0, od0!.max - 2 * cs.min),
    mid: Math.max(0, od0!.mid - 2 * cs.mid),
    text: `≈${Math.max(0, od0!.mid - 2 * cs.mid).toFixed(3)} (ref)`,
  };
  if (!(od.mid > id.mid)) return null;

  const material = pick(entries, ['MATT'], /MATERIAL/i)?.reply ?? null;
  const hardness = pick(entries, ['CQFM'], /HARDNESS/i)?.reply ?? null;
  const temp = pick(entries, ['ABJH'], /TEMP/i)?.reply ?? null;
  const unit = detectUnit(entries);

  // ---- geometry (viewBox 760x460; plan view left, section right) ----
  const cx = 205;
  const cy = 205;
  const R = 138; // outer radius on paper
  const r = Math.max(30, R * (id.mid / od.mid)); // inner radius, to scale
  const ringW = R - r;

  // Section view: two torus lobes, enlarged.
  const sx = 560;
  const sy = 175;
  const lobeR = 34;
  const lobeGap = Math.min(150, Math.max(96, (lobeR * 2 * id.mid) / cs.mid / 8));

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7;
    const w = 2.6;
    const p =
      dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  // Hatch pattern for the rubber section (full cross-hatch).
  const defs = `<defs>
    <pattern id="dg-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/>
    </pattern>
  </defs>`;

  // Plan view: annulus + centerlines + cutting plane A-A.
  const plan = `
    <circle cx="${cx}" cy="${cy}" r="${R}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" class="dg-edge"/>
    ${line(cx - R - 26, cy, cx + R + 26, cy, 'dg-center')}
    ${line(cx, cy - R - 26, cx, cy + R + 26, 'dg-center')}
    ${line(cx - R - 14, cy - R - 14, cx - R + 24, cy - R + 24, 'dg-cut')}
    ${line(cx + R - 24, cy + R - 24, cx + R + 14, cy + R + 14, 'dg-cut')}
    <text x="${cx - R - 20}" y="${cy - R - 20}" class="dg-label" text-anchor="middle">A</text>
    <text x="${cx + R + 20}" y="${cy + R + 30}" class="dg-label" text-anchor="middle">A</text>`;

  // OD dimension below the plan view.
  const odY = cy + R + 52;
  const odDim = `
    ${line(cx - R, cy + 6, cx - R, odY + 6, 'dg-ext')}
    ${line(cx + R, cy + 6, cx + R, odY + 6, 'dg-ext')}
    ${line(cx - R, odY, cx + R, odY, 'dg-dimline')}
    ${arrow(cx - R, odY, 'l')}${arrow(cx + R, odY, 'r')}
    ${dimText(cx, odY + 18, `⌀${od.text}  O.D.`)}`;

  // ID dimension across the middle (arrows inward on the inner circle).
  const idDim = `
    ${line(cx - r, cy - 14, cx + r, cy - 14, 'dg-dimline')}
    ${arrow(cx - r, cy - 14, 'l')}${arrow(cx + r, cy - 14, 'r')}
    ${dimText(cx, cy - 24, `⌀${id.text}  I.D.`)}`;

  // Section A-A: two hatched lobes on a centerline, enlarged scale.
  const halfGap = lobeGap / 2;
  const secDimY = sy - lobeR - 22;
  const section = `
    <text x="${sx}" y="${sy - lobeR - 66}" class="dg-label" text-anchor="middle">SECTION A-A</text>
    <text x="${sx}" y="${sy - lobeR - 52}" class="dg-note" text-anchor="middle">(ENLARGED)</text>
    ${line(sx - halfGap - lobeR - 22, sy, sx + halfGap + lobeR + 22, sy, 'dg-center')}
    ${line(sx, sy - lobeR - 8, sx, sy + lobeR + 14, 'dg-center')}
    <circle cx="${sx - halfGap}" cy="${sy}" r="${lobeR}" class="dg-sec"/>
    <circle cx="${sx + halfGap}" cy="${sy}" r="${lobeR}" class="dg-sec"/>
    ${line(sx + halfGap - lobeR, sy - lobeR - 4, sx + halfGap - lobeR, secDimY + 4, 'dg-ext')}
    ${line(sx + halfGap + lobeR, sy - lobeR - 4, sx + halfGap + lobeR, secDimY + 4, 'dg-ext')}
    ${line(sx + halfGap - lobeR, secDimY, sx + halfGap + lobeR, secDimY, 'dg-dimline')}
    ${arrow(sx + halfGap - lobeR, secDimY, 'l')}${arrow(sx + halfGap + lobeR, secDimY, 'r')}
    ${dimText(sx + halfGap, secDimY - 8, `⌀${cs.text}`)}
    ${dimText(sx, sy + lobeR + 38, 'CROSS SECTION', 'middle')}`;

  // Title block.
  const tbY = 460;
  const tbItems = [
    opts.itemName ?? 'RING SEAL',
    material ? material : null,
    hardness ? hardness.replace(/NOMINAL/i, 'NOM.') : null,
    temp ? temp.replace(/(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)\s*FAHRENHEIT/i, '$1 / $2 °F') : null,
  ].filter(Boolean) as string[];
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>
    `;

  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch); }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-cut { stroke: var(--ink); stroke-width: 2.4; stroke-dasharray: 10 4; }
    .dg-hatchline { stroke: var(--ink-soft); stroke-width: 0.8; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-none { stroke: none; fill: none; }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; }
    .dg-note { font-size: 10.5px; fill: var(--ink-soft); letter-spacing: 0.04em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${plan}${odDim}${idDim}${section}${title}
</svg>`;
}

// --- Flanged sleeve bearing (bushing) --------------------------------
// A stepped part: cylindrical body with a bore, plus a wider flange at
// one end. Drawn as an end view (concentric bore / body OD / flange OD)
// and a longitudinal full section (hatched wall with the flange step).

function parseDimAll(reply: string | null): Dim | null {
  if (!reply) return null;
  const nums = reply.match(/(\d+\.\d+)/g);
  if (!nums) return null;
  const vals = nums.map(Number).filter((n) => n > 0);
  if (vals.length === 0) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  return { min, max, mid: (min + max) / 2, text: min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}` };
}

/**
 * Tries each requirement-matching pattern in priority order and returns the
 * first one whose reply parses into a usable Dim. FLIS requirement labels
 * vary by NSN/FSC ("OUTSIDE DIAMETER" vs "WASHER OUTSIDE DIAMETER", etc.),
 * so generators pass several candidate patterns instead of assuming one
 * exact label is used catalog-wide.
 */
function findDim(entries: CharacteristicEntry[], pats: RegExp[]): Dim | null {
  for (const pat of pats) {
    const e = entries.find((x) => x.requirement && pat.test(x.requirement));
    const d = e ? parseDimAll(e.reply) : null;
    if (d) return d;
  }
  return null;
}

/** Same idea as findDim, for free-text replies (material, thread class, ...). */
function findText(entries: CharacteristicEntry[], pats: RegExp[]): string | null {
  for (const pat of pats) {
    const e = entries.find((x) => x.requirement && pat.test(x.requirement));
    if (e?.reply) return e.reply;
  }
  return null;
}

export function buildFlangedBearingDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const g = (pat: RegExp) => {
    const e = entries.find((x) => x.requirement && pat.test(x.requirement));
    return e ? parseDimAll(e.reply) : null;
  };
  const bodyOD = g(/BODY OUTSIDE DIAMETER/i);
  const bodyID = g(/BODY INSIDE DIAMETER|BORE/i);
  const flangeOD = g(/FLANGE OUTSIDE DIAMETER/i);
  const flangeW = g(/FLANGE WIDTH|FLANGE THICKNESS/i);
  const len = g(/OVERALL LENGTH|BODY LENGTH/i);
  if (!bodyOD || !bodyID || !flangeOD || !flangeW || !len) return null;
  if (!(flangeOD.mid > bodyOD.mid && bodyOD.mid > bodyID.mid)) return null;

  const material = entries.find((e) => e.requirement && /^MATERIAL$/i.test(e.requirement))?.reply
    ?? entries.find((e) => e.requirement && /MATERIAL DOCUMENT/i.test(e.requirement))?.reply ?? null;
  const hardness = entries.find((e) => e.requirement && /HARDNESS/i.test(e.requirement))?.reply ?? null;
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  const defs = `<defs>
    <pattern id="dg-hatch2" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/>
    </pattern></defs>`;

  // ---- End view (left): concentric circles, true relative scale ----
  // Short ring labels with leader dots; all numeric diameters live on the
  // section's stacked dimensions to keep this view uncluttered.
  const ex = 158, ey = 205;
  const endScale = 108 / (flangeOD.mid / 2);
  const rFl = (flangeOD.mid / 2) * endScale;
  const rBo = (bodyOD.mid / 2) * endScale;
  const rBore = (bodyID.mid / 2) * endScale;
  // Leaders carry the diameters here (where the circles are), so the
  // section can stay clean.
  const leader = (r: number, label: string, num: string, dy: number) => {
    const ang = -0.9; // upper-right
    const x1 = ex + Math.cos(ang) * r;
    const y1 = ey + Math.sin(ang) * r;
    const x2 = ex + rFl + 18;
    return `${line(x1, y1, x2 - 4, y1 + dy, 'dg-ext')}<circle cx="${x1}" cy="${y1}" r="1.6" class="dg-fill"/>
      <text x="${x2}" y="${y1 + dy + 1}" class="dg-note" text-anchor="start">${esc(label)}</text>
      <text x="${x2}" y="${y1 + dy + 14}" class="dg-dim" text-anchor="start">${esc(num)}</text>`;
  };
  const endView = `
    <text x="${ex}" y="40" class="dg-label" text-anchor="middle">END VIEW</text>
    ${line(ex - rFl - 24, ey, ex + rFl + 12, ey, 'dg-center')}
    ${line(ex, ey - rFl - 24, ex, ey + rFl + 24, 'dg-center')}
    <circle cx="${ex}" cy="${ey}" r="${rFl}" class="dg-edge"/>
    <circle cx="${ex}" cy="${ey}" r="${rBo}" class="dg-edge"/>
    <circle cx="${ex}" cy="${ey}" r="${rBore}" class="dg-edge"/>
    ${leader(rFl, 'FLANGE OD', `⌀${flangeOD.text}`, -46)}
    ${leader(rBo, 'BODY OD', `⌀${bodyOD.text}`, -2)}
    ${leader(rBore, 'BORE', `⌀${bodyID.text}`, 40)}`;

  // ---- Longitudinal full section (right) ----
  const secScale = Math.min(120 / flangeOD.mid, 138 / len.mid);
  const L = len.mid * secScale;
  const Wf = flangeW.mid * secScale;
  const yFl = (flangeOD.mid / 2) * secScale;
  const yBo = (bodyOD.mid / 2) * secScale;
  const yBore = (bodyID.mid / 2) * secScale;
  const sx0 = 470; // left edge (flange face)
  const scy = 205; // section centerline y
  const xFlEnd = sx0 + Wf;
  const xEnd = sx0 + L;

  // One wall half as a hatched polygon (flange step + body), mirrored.
  const halfPath = (sign: number) => {
    const b = (v: number) => scy + sign * v;
    return `M ${sx0} ${b(yBore)} L ${sx0} ${b(yFl)} L ${xFlEnd} ${b(yFl)} L ${xFlEnd} ${b(yBo)} L ${xEnd} ${b(yBo)} L ${xEnd} ${b(yBore)} Z`;
  };
  const secDimYtop = scy - yFl - 30;
  // The section carries the two dimensions the end view can't show:
  // overall length and flange width. Diameters live on the end-view leaders.
  const section = `
    <text x="${(sx0 + xEnd) / 2 + 20}" y="40" class="dg-label" text-anchor="middle">SECTION</text>
    <path d="${halfPath(1)}" class="dg-sec"/>
    <path d="${halfPath(-1)}" class="dg-sec"/>
    ${line(sx0 - 16, scy, xEnd + 34, scy, 'dg-center')}
    <!-- overall length (top) -->
    ${line(sx0, scy - yFl - 6, sx0, secDimYtop - 6, 'dg-ext')}
    ${line(xEnd, scy - yBo - 6, xEnd, secDimYtop - 6, 'dg-ext')}
    ${line(sx0, secDimYtop, xEnd, secDimYtop, 'dg-dimline')}
    ${arrow(sx0, secDimYtop, 'l')}${arrow(xEnd, secDimYtop, 'r')}
    ${dimText((sx0 + xEnd) / 2, secDimYtop - 8, `${len.text} LG`)}
    <!-- flange width (bottom-left) -->
    ${line(sx0, scy + yFl + 6, sx0, scy + yFl + 44, 'dg-ext')}
    ${line(xFlEnd, scy + yFl + 6, xFlEnd, scy + yFl + 44, 'dg-ext')}
    ${line(sx0, scy + yFl + 38, xFlEnd, scy + yFl + 38, 'dg-dimline')}
    ${arrow(sx0, scy + yFl + 38, 'l')}${arrow(xFlEnd, scy + yFl + 38, 'r')}
    ${dimText((sx0 + xFlEnd) / 2, scy + yFl + 58, `${flangeW.text} FLG W`)}`;

  const tbY = 462;
  const short = (t: string | null, n: number) => (t && t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
  const tbItems = [
    opts.itemName ?? 'SLEEVE BEARING',
    short(material ? material.replace(/\s+OR\s+/gi, ' / ') : null, 46),
    hardness ? short(hardness.replace(/ROCKWELL C/gi, 'HRC').replace(/MINIMUM/gi, 'min').replace(/MAXIMUM/gi, 'max'), 30) : null,
  ].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch2); }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-none { stroke: none; fill: none; }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${endView}${section}${title}
</svg>`;
}

// --- Plate nut / anchor nut (two-lug, self-locking) ------------------
// A non-round part: an obround plate with a central threaded barrel and a
// two-hole rivet pattern. Drawn as a face view (plate outline, thread +
// counterbore, two mounting holes on a bolt-pattern centerline) and a
// projected front view (plate + raised barrel), from real FLIS geometry.

export function buildPlateNutDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const g = (pat: RegExp) => {
    const e = entries.find((x) => x.requirement && pat.test(x.requirement));
    return e ? parseDimAll(e.reply) : null;
  };
  const txt = (pat: RegExp) => {
    const e = entries.find((x) => x.requirement && pat.test(x.requirement));
    return e?.reply ?? null;
  };
  const len = g(/NUT LENGTH|OVERALL LENGTH/i);
  const width = g(/PLATE WIDTH|NUT WIDTH/i);
  const c2c = g(/CENTER TO CENTER DISTANCE BETWEEN MOUNTING HOLES/i);
  const holeD = g(/MOUNTING HOLE DIAMETER/i);
  const thread = g(/NOMINAL THREAD SIZE/i);
  const cbore = g(/COUNTERBORE DIAMETER/i);
  const nutH = g(/NUT HEIGHT/i);
  const overallH = g(/OVERALL HEIGHT/i);
  if (!len || !width || !c2c || !holeD || !thread) return null;

  const tpi = (txt(/THREAD QUANTITY PER INCH/i) || '').match(/\d+/)?.[0] ?? null;
  const tClass = (txt(/THREAD CLASS/i) || '').trim() || null;
  const material = entries.find((e) => e.requirement && /^MATERIAL$/i.test(e.requirement))?.reply
    ?? entries.find((e) => e.requirement && /NUT STYLE/i.test(e.requirement))?.reply ?? null;
  const unit = detectUnit(entries);
  const threadCallout = `${thread.text}-${tpi ?? ''}${tClass ? ' ' + tClass : ''}`.replace(/-\s/, ' ');

  const esc2 = esc;
  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc2(t)}</text>`;

  // Single scale for both views so they project truthfully.
  const oHmid = overallH?.mid ?? (nutH?.mid ?? 0.3) + 0.2;
  const scale = Math.min(276 / len.mid, 165 / (width.mid / 2 + oHmid));
  const L = len.mid * scale;
  const W = width.mid * scale;
  const half = c2c.mid / 2 * scale;
  const rHole = (holeD.mid / 2) * scale;
  const rThr = (thread.mid / 2) * scale;
  const rCb = cbore ? (cbore.mid / 2) * scale : rThr * 1.25;

  const cx = 300;
  const fy = 150;               // face-view centerline y
  const xL = cx - L / 2, xR = cx + L / 2;
  const capR = W / 2;           // obround end radius

  // Obround plate outline (stadium): straight top/bottom + semicircle ends.
  const plate = `M ${xL + capR} ${fy - W / 2}
    L ${xR - capR} ${fy - W / 2}
    A ${capR} ${capR} 0 0 1 ${xR - capR} ${fy + W / 2}
    L ${xL + capR} ${fy + W / 2}
    A ${capR} ${capR} 0 0 1 ${xL + capR} ${fy - W / 2} Z`;

  const faceView = `
    <text x="${cx}" y="40" class="dg-label" text-anchor="middle">FACE VIEW</text>
    <path d="${plate}" class="dg-edge"/>
    <circle cx="${cx}" cy="${fy}" r="${rCb}" class="dg-edge"/>
    <circle cx="${cx}" cy="${fy}" r="${rThr}" class="dg-edge"/>
    <circle cx="${cx - half}" cy="${fy}" r="${rHole}" class="dg-edge"/>
    <circle cx="${cx + half}" cy="${fy}" r="${rHole}" class="dg-edge"/>
    ${line(xL - 18, fy, xR + 18, fy, 'dg-center')}
    ${line(cx, fy - W / 2 - 16, cx, fy + W / 2 + 16, 'dg-center')}
    ${line(cx - half, fy - rHole - 10, cx - half, fy + rHole + 10, 'dg-center')}
    ${line(cx + half, fy - rHole - 10, cx + half, fy + rHole + 10, 'dg-center')}
    <!-- thread + counterbore callout -->
    ${line(cx + rCb * 0.7, fy - rCb * 0.7, cx + rCb + 40, fy - rCb - 30, 'dg-ext')}
    <text x="${cx + rCb + 44}" y="${fy - rCb - 32}" class="dg-dim" text-anchor="start">⌀${esc2(threadCallout)}</text>
    <text x="${cx + rCb + 44}" y="${fy - rCb - 19}" class="dg-note" text-anchor="start">THREAD${cbore ? ` · ⌀${esc2(cbore.text)} C'BORE` : ''}</text>
    <!-- mounting hole callout -->
    ${line(cx - half - rHole * 0.7, fy + rHole * 0.7, cx - half - 34, fy + rHole + 34, 'dg-ext')}
    <text x="${cx - half - 38}" y="${fy + rHole + 36}" class="dg-dim" text-anchor="end">2× ⌀${esc2(holeD.text)}</text>
    <!-- bolt pattern (center-to-center), above the plate -->
    ${line(cx - half, fy - W / 2 - 6, cx - half, fy - W / 2 - 34, 'dg-ext')}
    ${line(cx + half, fy - W / 2 - 6, cx + half, fy - W / 2 - 34, 'dg-ext')}
    ${line(cx - half, fy - W / 2 - 28, cx + half, fy - W / 2 - 28, 'dg-dimline')}
    ${arrow(cx - half, fy - W / 2 - 28, 'l')}${arrow(cx + half, fy - W / 2 - 28, 'r')}
    ${dimText(cx, fy - W / 2 - 34, `${c2c.text} C-C`)}
    <!-- overall length, below the plate -->
    ${line(xL, fy + W / 2 + 6, xL, fy + W / 2 + 40, 'dg-ext')}
    ${line(xR, fy + W / 2 + 6, xR, fy + W / 2 + 40, 'dg-ext')}
    ${line(xL, fy + W / 2 + 34, xR, fy + W / 2 + 34, 'dg-dimline')}
    ${arrow(xL, fy + W / 2 + 34, 'l')}${arrow(xR, fy + W / 2 + 34, 'r')}
    ${dimText(cx, fy + W / 2 + 54, `${len.text} LG`)}
    <!-- plate width, on the right -->
    ${line(xR + 8, fy - W / 2, xR + 40, fy - W / 2, 'dg-ext')}
    ${line(xR + 8, fy + W / 2, xR + 40, fy + W / 2, 'dg-ext')}
    ${line(xR + 34, fy - W / 2, xR + 34, fy + W / 2, 'dg-dimline')}
    ${arrow(xR + 34, fy - W / 2, 'u')}${arrow(xR + 34, fy + W / 2, 'd')}
    <text x="${xR + 40}" y="${fy + 4}" class="dg-dim" text-anchor="start">${esc2(width.text)} W</text>`;

  // Front view (projected below): plate bar + central raised barrel.
  const oH = oHmid * scale;
  const vy = fy + W / 2 + oH / 2 + 132;
  const bH = (nutH?.mid ?? oH / scale * 0.5) * scale;   // barrel height above plate
  const plateThk = Math.max(14, oH - bH);
  const yBase = vy + oH / 2;
  const yPlateTop = yBase - plateThk;
  const yTop = yBase - oH;
  const barrelW = Math.max(rCb * 2, 40);
  const frontView = `
    <text x="${cx}" y="${yTop - 34}" class="dg-label" text-anchor="middle">FRONT VIEW</text>
    <!-- plate bar -->
    <rect x="${xL}" y="${yPlateTop}" width="${L}" height="${plateThk}" class="dg-sec"/>
    <!-- raised barrel -->
    <rect x="${cx - barrelW / 2}" y="${yTop}" width="${barrelW}" height="${yPlateTop - yTop}" class="dg-sec"/>
    <!-- thread bore (hidden) up through barrel -->
    ${line(cx - rThr, yTop + 4, cx - rThr, yBase, 'dg-hidden')}
    ${line(cx + rThr, yTop + 4, cx + rThr, yBase, 'dg-hidden')}
    <!-- mounting holes (hidden) through plate -->
    ${line(cx - half, yPlateTop, cx - half, yBase, 'dg-hidden')}
    ${line(cx + half, yPlateTop, cx + half, yBase, 'dg-hidden')}
    ${line(xL - 18, yBase, xR + 18, yBase, 'dg-center')}
    ${overallH ? `
    ${line(xL - 6, yTop, xL - 40, yTop, 'dg-ext')}
    ${line(xL - 6, yBase, xL - 40, yBase, 'dg-ext')}
    ${line(xL - 34, yTop, xL - 34, yBase, 'dg-dimline')}
    ${arrow(xL - 34, yTop, 'u')}${arrow(xL - 34, yBase, 'd')}
    <text x="${xL - 40}" y="${(yTop + yBase) / 2}" class="dg-dim" text-anchor="end">${esc2(overallH.text)}</text>
    <text x="${xL - 40}" y="${(yTop + yBase) / 2 + 13}" class="dg-note" text-anchor="end">OVERALL H</text>` : ''}
    ${nutH ? `
    ${line(cx + barrelW / 2 + 6, yTop, cx + barrelW / 2 + 34, yTop, 'dg-ext')}
    ${line(cx + barrelW / 2 + 6, yPlateTop, cx + barrelW / 2 + 34, yPlateTop, 'dg-ext')}
    ${line(cx + barrelW / 2 + 28, yTop, cx + barrelW / 2 + 28, yPlateTop, 'dg-dimline')}
    ${arrow(cx + barrelW / 2 + 28, yTop, 'u')}${arrow(cx + barrelW / 2 + 28, yPlateTop, 'd')}
    <text x="${cx + barrelW / 2 + 40}" y="${(yTop + yPlateTop) / 2 + 4}" class="dg-dim" text-anchor="start">${esc2(nutH.text)} NUT H</text>` : ''}`;

  const tbY = 468;
  const short = (t: string | null, n: number) => (t && t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
  const tbItems = [opts.itemName ?? 'PLATE NUT', short(material, 40), threadCallout ? `THREAD ${threadCallout}` : null].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch2); }
    .dg-hidden { stroke: var(--ink-soft); stroke-width: 1.1; stroke-dasharray: 5 3; }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 12.5px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const defs = `<defs><pattern id="dg-hatch2" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/></pattern></defs>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc2(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc2(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc2(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${faceView}${frontView}${title}
</svg>`;
}

// --- Flat washer ---------------------------------------------------------
// A plain annulus: outside diameter, inside (bore) diameter, thickness.
// Drawn as a plan view (concentric circles, OD/ID dimensioned, A-A cutting
// plane — same convention as buildRingDiagram) plus a section A-A: a
// straight radial slice through a flat annulus is two rectangular wall
// bars separated by the bore, which is what's drawn on the right.
export function buildWasherDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const od = findDim(entries, [/\bOUTSIDE DIAMETER\b/i, /\bWASHER OUTSIDE DIAMETER\b/i, /\bOUTER DIAMETER\b/i, /\bOD\b/i]);
  const id = findDim(entries, [/\bINSIDE DIAMETER\b/i, /\bBORE DIAMETER\b/i, /\bNOMINAL (?:INSIDE )?DIAMETER\b/i, /\bINNER DIAMETER\b/i, /\bID\b/i, /\bBORE\b/i]);
  const thk = findDim(entries, [/\bTHICKNESS\b/i, /\bNOMINAL THICKNESS\b/i, /\bHEIGHT\b/i, /\bWIDTH\b/i]);
  if (!od || !id || !thk) return null;
  if (!(od.mid > id.mid)) return null;

  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  const defs = `<defs>
    <pattern id="dg-hatch-w" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/>
    </pattern>
  </defs>`;

  // Plan view: annulus + centerlines + A-A cutting plane, true relative scale.
  const cx = 205, cy = 205, R = 138;
  const r = Math.max(30, R * (id.mid / od.mid));
  const plan = `
    <circle cx="${cx}" cy="${cy}" r="${R}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" class="dg-edge"/>
    ${line(cx - R - 26, cy, cx + R + 26, cy, 'dg-center')}
    ${line(cx, cy - R - 26, cx, cy + R + 26, 'dg-center')}
    ${line(cx - R - 14, cy - R - 14, cx - R + 24, cy - R + 24, 'dg-cut')}
    ${line(cx + R - 24, cy + R - 24, cx + R + 14, cy + R + 14, 'dg-cut')}
    <text x="${cx - R - 20}" y="${cy - R - 20}" class="dg-label" text-anchor="middle">A</text>
    <text x="${cx + R + 20}" y="${cy + R + 30}" class="dg-label" text-anchor="middle">A</text>`;

  const odY = cy + R + 52;
  const odDim = `
    ${line(cx - R, cy + 6, cx - R, odY + 6, 'dg-ext')}
    ${line(cx + R, cy + 6, cx + R, odY + 6, 'dg-ext')}
    ${line(cx - R, odY, cx + R, odY, 'dg-dimline')}
    ${arrow(cx - R, odY, 'l')}${arrow(cx + R, odY, 'r')}
    ${dimText(cx, odY + 18, `⌀${od.text}  O.D.`)}`;

  const idDim = `
    ${line(cx - r, cy - 14, cx + r, cy - 14, 'dg-dimline')}
    ${arrow(cx - r, cy - 14, 'l')}${arrow(cx + r, cy - 14, 'r')}
    ${dimText(cx, cy - 24, `⌀${id.text}  I.D.`)}`;

  // Section A-A: a straight radial slice through the flat annulus is two
  // rectangular wall bars separated by the bore gap.
  const sx = 560, sy = 205;
  const wallRadial = Math.max(0.02, (od.mid - id.mid) / 2);
  const secScale = Math.min(150 / wallRadial, 90 / thk.mid);
  const wallW = wallRadial * secScale;
  const thkH = thk.mid * secScale;
  const gap = Math.min(140, Math.max(60, wallW * 1.1));
  const rectTop = sy - thkH / 2;
  const rectBot = sy + thkH / 2;
  const rectRx0 = sx + gap / 2;
  const rectRx1 = rectRx0 + wallW;
  const dimX = rectRx1 + 30;
  const section = `
    <text x="${sx}" y="${rectTop - 56}" class="dg-label" text-anchor="middle">SECTION A-A</text>
    <text x="${sx}" y="${rectTop - 42}" class="dg-note" text-anchor="middle">(ENLARGED)</text>
    ${line(sx - gap / 2 - wallW - 22, sy, sx + gap / 2 + wallW + 22, sy, 'dg-center')}
    <rect x="${sx - gap / 2 - wallW}" y="${rectTop}" width="${wallW}" height="${thkH}" class="dg-sec"/>
    <rect x="${rectRx0}" y="${rectTop}" width="${wallW}" height="${thkH}" class="dg-sec"/>
    ${line(rectRx1, rectTop, dimX - 4, rectTop, 'dg-ext')}
    ${line(rectRx1, rectBot, dimX - 4, rectBot, 'dg-ext')}
    ${line(dimX, rectTop, dimX, rectBot, 'dg-dimline')}
    ${arrow(dimX, rectTop, 'u')}${arrow(dimX, rectBot, 'd')}
    ${dimText(dimX + 8, sy + 4, `${thk.text} THK`, 'start')}
    ${dimText(sx, rectBot + 34, 'CROSS SECTION', 'middle')}`;

  const tbY = 460;
  const tbItems = [opts.itemName ?? 'FLAT WASHER', material].filter(Boolean) as string[];
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch-w); }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-cut { stroke: var(--ink); stroke-width: 2.4; stroke-dasharray: 10 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; }
    .dg-note { font-size: 10.5px; fill: var(--ink-soft); letter-spacing: 0.04em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${plan}${odDim}${idDim}${section}${title}
</svg>`;
}

// --- Plain / hex nut -------------------------------------------------
// A hex-head nut with a threaded through-bore: width across flats, thread
// size, thickness/height. Drawn as a plan view (flat-top hexagon + bore,
// true relative scale) plus a side view (rectangle at the SAME scale, so
// the two views project truthfully off one scale factor — same convention
// as buildPlateNutDiagram's face/front pairing).
export function buildNutDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const waf = findDim(entries, [/\bWIDTH ACROSS FLATS\b/i, /\bACROSS FLATS\b/i]);
  const thread = findDim(entries, [/\bNOMINAL THREAD (?:DIAMETER|SIZE)\b/i, /\bTHREAD SIZE\b/i, /\bTHREAD CLASS\b/i]);
  const thk = findDim(entries, [/\bTHICKNESS\b/i, /\bNUT (?:HEIGHT|THICKNESS)\b/i, /\bHEIGHT\b/i, /\bWIDTH\b/i]);
  if (!waf || !thread || !thk) return null;
  if (!(waf.mid > thread.mid)) return null;

  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const threadClassText = findText(entries, [/THREAD CLASS/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };

  const defs = `<defs><pattern id="dg-hatch-n" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/></pattern></defs>`;

  // ---- Plan view: flat-top hexagon (top/bottom edges horizontal) + bore ----
  const cx = 190, cy = 205;
  const wafPaper = 190;
  const scale = wafPaper / waf.mid;
  const apothem = wafPaper / 2;
  const R = apothem / Math.cos(Math.PI / 6); // circumradius
  const hexPts = [-120, -60, 0, 60, 120, 180]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `${(cx + R * Math.cos(a)).toFixed(2)},${(cy + R * Math.sin(a)).toFixed(2)}`;
    })
    .join(' ');
  const rThread = (thread.mid / 2) * scale;
  const xRightEdge = cx + R * 0.5; // rightmost point of the top/bottom flats
  const topY = cy - apothem;
  const botY = cy + apothem;
  const dimX = cx + R + 40;
  const leadX1 = cx - rThread * 0.7;
  const leadY1 = cy - rThread * 0.7;
  const leadX2 = cx - R - 20;
  const leadY2 = cy - R - 30;

  const planView = `
    <text x="${cx}" y="40" class="dg-label" text-anchor="middle">PLAN VIEW</text>
    <polygon points="${hexPts}" class="dg-edge"/>
    <circle cx="${cx}" cy="${cy}" r="${rThread}" class="dg-edge"/>
    ${line(cx - R - 20, cy, cx + R + 20, cy, 'dg-center')}
    ${line(cx, cy - R - 20, cx, cy + R + 20, 'dg-center')}
    ${line(xRightEdge, topY, dimX - 4, topY, 'dg-ext')}
    ${line(xRightEdge, botY, dimX - 4, botY, 'dg-ext')}
    ${line(dimX, topY, dimX, botY, 'dg-dimline')}
    ${arrow(dimX, topY, 'u')}${arrow(dimX, botY, 'd')}
    <text x="${dimX + 8}" y="${cy + 4}" class="dg-dim" text-anchor="start">${esc(waf.text)} A/F</text>
    ${line(leadX1, leadY1, leadX2, leadY2, 'dg-ext')}
    <circle cx="${leadX1}" cy="${leadY1}" r="1.6" class="dg-fill"/>
    <text x="${leadX2 - 4}" y="${leadY2 - 2}" class="dg-dim" text-anchor="end">⌀${esc(thread.text)}</text>
    <text x="${leadX2 - 4}" y="${leadY2 + 12}" class="dg-note" text-anchor="end">THREAD${threadClassText ? ' ' + esc(threadClassText) : ''}</text>`;

  // ---- Side view (right): rectangle at the SAME scale, thread bore hidden ----
  const sx0 = 470;
  const wSide = wafPaper;
  const xR = sx0 + wSide;
  const midX = (sx0 + xR) / 2;
  const thkPaper = Math.max(16, thk.mid * scale);
  const scy = 205;
  const yTop = scy - thkPaper / 2;
  const yBot = scy + thkPaper / 2;
  const dimX2 = xR + 30;
  const sideView = `
    <text x="${midX}" y="40" class="dg-label" text-anchor="middle">SIDE VIEW</text>
    <rect x="${sx0}" y="${yTop}" width="${wSide}" height="${thkPaper}" class="dg-sec"/>
    ${line(sx0 - 16, scy, xR + 16, scy, 'dg-center')}
    ${line(midX - rThread, yTop, midX - rThread, yBot, 'dg-hidden')}
    ${line(midX + rThread, yTop, midX + rThread, yBot, 'dg-hidden')}
    ${line(xR, yTop, dimX2 - 4, yTop, 'dg-ext')}
    ${line(xR, yBot, dimX2 - 4, yBot, 'dg-ext')}
    ${line(dimX2, yTop, dimX2, yBot, 'dg-dimline')}
    ${arrow(dimX2, yTop, 'u')}${arrow(dimX2, yBot, 'd')}
    <text x="${dimX2 + 8}" y="${scy + 4}" class="dg-dim" text-anchor="start">${esc(thk.text)} THK</text>`;

  const tbY = 462;
  const threadCallout = `⌀${thread.text}${threadClassText ? ' ' + threadClassText : ''}`;
  const tbItems = [opts.itemName ?? 'HEX NUT', material, `THREAD ${threadCallout}`].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch-n); }
    .dg-hidden { stroke: var(--ink-soft); stroke-width: 1.1; stroke-dasharray: 5 3; }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${planView}${sideView}${title}
</svg>`;
}

// --- Sleeve / spacer / plain bushing --------------------------------
// A simple tube: body outside diameter, bore (inside diameter), overall
// length. Drawn as an end view (concentric OD/bore circles, leader labels
// — same convention as buildFlangedBearingDiagram's end view) plus a
// longitudinal full section: the tube sliced along its axis is two hatched
// wall strips the length of the part, separated by the bore.
export function buildSleeveDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const od = findDim(entries, [/\bOUTSIDE DIAMETER\b/i, /\bBODY OUTSIDE DIAMETER\b/i, /\bOUTER DIAMETER\b/i, /\bOD\b/i]);
  const id = findDim(entries, [/\bINSIDE DIAMETER\b/i, /\bBORE\b/i, /\bINTERNAL DIAMETER\b/i, /\bINNER DIAMETER\b/i, /\bID\b/i]);
  const len = findDim(entries, [/\bOVERALL LENGTH\b/i, /\bLENGTH\b/i, /\bHEIGHT\b/i]);
  if (!od || !id || !len) return null;
  if (!(od.mid > id.mid)) return null;

  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  const defs = `<defs><pattern id="dg-hatch-s" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--ink-soft);stroke-width:0.9"/></pattern></defs>`;

  // ---- End view (left): concentric circles, true relative scale ----
  const ex = 165, ey = 205;
  const endScale = 105 / (od.mid / 2);
  const rOD = (od.mid / 2) * endScale;
  const rID = Math.max(10, (id.mid / 2) * endScale);
  const leader = (r: number, label: string, num: string, dy: number) => {
    const ang = -0.9;
    const x1 = ex + Math.cos(ang) * r;
    const y1 = ey + Math.sin(ang) * r;
    const x2 = ex + rOD + 18;
    return `${line(x1, y1, x2 - 4, y1 + dy, 'dg-ext')}<circle cx="${x1}" cy="${y1}" r="1.6" class="dg-fill"/>
      <text x="${x2}" y="${y1 + dy + 1}" class="dg-note" text-anchor="start">${esc(label)}</text>
      <text x="${x2}" y="${y1 + dy + 14}" class="dg-dim" text-anchor="start">${esc(num)}</text>`;
  };
  const endView = `
    <text x="${ex}" y="40" class="dg-label" text-anchor="middle">END VIEW</text>
    ${line(ex - rOD - 22, ey, ex + rOD + 12, ey, 'dg-center')}
    ${line(ex, ey - rOD - 22, ex, ey + rOD + 22, 'dg-center')}
    <circle cx="${ex}" cy="${ey}" r="${rOD}" class="dg-edge"/>
    <circle cx="${ex}" cy="${ey}" r="${rID}" class="dg-edge"/>
    ${leader(rOD, 'OUTSIDE DIA', `⌀${od.text}`, -30)}
    ${leader(rID, 'BORE', `⌀${id.text}`, 26)}`;

  // ---- Longitudinal full section (right) ----
  const secScale = Math.min(220 / len.mid, 130 / od.mid);
  const L = len.mid * secScale;
  const yOD = (od.mid / 2) * secScale;
  const yID = Math.max(4, (id.mid / 2) * secScale);
  const sx0 = 430, scy = 205;
  const xEnd = sx0 + L;
  const halfPath = (sign: number) => {
    const outer = scy + sign * yOD;
    const inner = scy + sign * yID;
    return `M ${sx0} ${inner} L ${sx0} ${outer} L ${xEnd} ${outer} L ${xEnd} ${inner} Z`;
  };
  const secDimY = scy - yOD - 30;
  const section = `
    <text x="${(sx0 + xEnd) / 2}" y="40" class="dg-label" text-anchor="middle">SECTION</text>
    <path d="${halfPath(1)}" class="dg-sec"/>
    <path d="${halfPath(-1)}" class="dg-sec"/>
    ${line(sx0 - 16, scy, xEnd + 34, scy, 'dg-center')}
    ${line(sx0, scy - yOD - 6, sx0, secDimY - 6, 'dg-ext')}
    ${line(xEnd, scy - yOD - 6, xEnd, secDimY - 6, 'dg-ext')}
    ${line(sx0, secDimY, xEnd, secDimY, 'dg-dimline')}
    ${arrow(sx0, secDimY, 'l')}${arrow(xEnd, secDimY, 'r')}
    ${dimText((sx0 + xEnd) / 2, secDimY - 8, `${len.text} LG`)}`;

  const tbY = 462;
  const tbItems = [opts.itemName ?? 'SLEEVE / SPACER', material].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-sec { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-hatch-s); }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${endView}${section}${title}
</svg>`;
}

// --- Straight pin / dowel ---------------------------------------------
// A solid cylinder: diameter, overall length. Drawn as a side elevation
// (rectangle, true relative scale, with small corner chamfers — no
// hatching, since a solid pin has no bore to section) plus an end view (a
// single circle at the same scale).
export function buildPinDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const dia = findDim(entries, [/\bDIAMETER\b/i, /\bPIN DIAMETER\b/i, /\bSHANK DIAMETER\b/i, /\bNOMINAL DIAMETER\b/i, /\bOD\b/i, /\bOUTSIDE DIAMETER\b/i]);
  const len = findDim(entries, [/\bOVERALL LENGTH\b/i, /\bLENGTH\b/i, /\bPIN LENGTH\b/i]);
  if (!dia || !len) return null;
  if (!(len.mid > dia.mid)) return null; // a pin/dowel is longer than it is wide

  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  // ---- Side view (left): rectangle, true relative scale, chamfered corners ----
  const scale = Math.min(430 / len.mid, 90 / dia.mid);
  const L = len.mid * scale;
  const D = Math.max(10, dia.mid * scale);
  const sx0 = 60, scy = 175;
  const xEnd = sx0 + L;
  const yTop = scy - D / 2, yBot = scy + D / 2;
  const chamfer = Math.max(2, Math.min(10, D / 3, L / 8));
  const sideView = `
    <text x="${(sx0 + xEnd) / 2}" y="40" class="dg-label" text-anchor="middle">SIDE VIEW</text>
    <path d="M ${sx0 + chamfer} ${yTop}
      L ${xEnd - chamfer} ${yTop} L ${xEnd} ${yTop + chamfer}
      L ${xEnd} ${yBot - chamfer} L ${xEnd - chamfer} ${yBot}
      L ${sx0 + chamfer} ${yBot} L ${sx0} ${yBot - chamfer}
      L ${sx0} ${yTop + chamfer} Z" class="dg-edge"/>
    ${line(sx0 - 16, scy, xEnd + 16, scy, 'dg-center')}`;

  const secDimY = yTop - 30;
  const lengthDim = `
    ${line(sx0, yTop - 6, sx0, secDimY - 6, 'dg-ext')}
    ${line(xEnd, yTop - 6, xEnd, secDimY - 6, 'dg-ext')}
    ${line(sx0, secDimY, xEnd, secDimY, 'dg-dimline')}
    ${arrow(sx0, secDimY, 'l')}${arrow(xEnd, secDimY, 'r')}
    ${dimText((sx0 + xEnd) / 2, secDimY - 8, `${len.text} LG`)}`;

  const diaDimX = Math.max(16, sx0 - 40);
  const diaDim = `
    ${line(sx0 - 6, yTop, diaDimX + 4, yTop, 'dg-ext')}
    ${line(sx0 - 6, yBot, diaDimX + 4, yBot, 'dg-ext')}
    ${line(diaDimX, yTop, diaDimX, yBot, 'dg-dimline')}
    ${arrow(diaDimX, yTop, 'u')}${arrow(diaDimX, yBot, 'd')}
    <text x="${diaDimX - 8}" y="${scy + 4}" class="dg-dim" text-anchor="end">⌀${esc(dia.text)}</text>`;

  // ---- End view (right): single circle, same scale ----
  const ecx = Math.min(640, xEnd + 90), ecy = 175;
  const rEnd = D / 2;
  const endView = `
    <text x="${ecx}" y="40" class="dg-label" text-anchor="middle">END VIEW</text>
    ${line(ecx - rEnd - 20, ecy, ecx + rEnd + 20, ecy, 'dg-center')}
    ${line(ecx, ecy - rEnd - 20, ecx, ecy + rEnd + 20, 'dg-center')}
    <circle cx="${ecx}" cy="${ecy}" r="${rEnd}" class="dg-edge"/>`;

  const tbY = 462;
  const tbItems = [opts.itemName ?? 'STRAIGHT PIN', material].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${unitTag}${sideView}${lengthDim}${diaDim}${endView}${title}
</svg>`;
}

// --- Threaded fastener (screw / bolt / stud) --------------------------
// A head block plus a threaded shank: nominal thread/shank diameter and
// overall length are required; head diameter/width is optional (FLIS
// doesn't always carry it for every fastener) — when it's absent, or when
// a matched value is smaller than the shank (a bad/irrelevant match), a
// generic head sized ~1.6x the shank diameter is drawn instead so the
// silhouette still reads as a fastener. Drawn as a single side view (the
// head as a plain block, the shank hatched to denote threading) — same
// dimensioning convention (extension/dimension lines, arrowheads) as
// buildPinDiagram.
export function buildScrewDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const dia = findDim(entries, [
    /\bNOMINAL THREAD (?:DIAMETER|SIZE)\b/i,
    /\bTHREAD SIZE\b/i,
    /\bNOMINAL DIAMETER\b/i,
    /\bSHANK DIAMETER\b/i,
  ]);
  const len = findDim(entries, [/\b(?:OVERALL |NOMINAL )?LENGTH\b/i, /\bFASTENER LENGTH\b/i]);
  if (!dia || !len) return null;
  if (!(len.mid > dia.mid)) return null; // a screw/bolt/stud is longer than it is wide

  let headD = findDim(entries, [/\bHEAD (?:DIAMETER|WIDTH|HEIGHT)\b/i, /\bWIDTH ACROSS FLATS\b/i]);
  if (headD && !(headD.mid > dia.mid)) headD = null; // bad/irrelevant match — fall back to a generic head

  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const threadClassText = findText(entries, [/THREAD CLASS/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  const defs = `<defs><pattern id="dg-thread" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <line x1="0" y1="0" x2="0" y2="5" style="stroke:var(--ink);stroke-width:1"/></pattern></defs>`;

  // ---- Side view: head block + threaded shank, true relative scale ----
  const headDiaReal = headD ? headD.mid : dia.mid * 1.6;
  const headLenReal = Math.min(dia.mid * 0.75, len.mid * 0.3);
  const shankLenReal = Math.max(dia.mid * 0.2, len.mid - headLenReal);
  const totalReal = headLenReal + shankLenReal;
  const scale = Math.min(430 / totalReal, 90 / headDiaReal);

  const sx0 = 60, scy = 175;
  const headLenPx = headLenReal * scale;
  const shankLenPx = shankLenReal * scale;
  const xHeadEnd = sx0 + headLenPx;
  const xEnd = xHeadEnd + shankLenPx;
  const Hh = Math.max(14, (headDiaReal / 2) * scale);
  const Sh = Math.max(6, Math.min(Hh - 2, (dia.mid / 2) * scale));

  const sideView = `
    <text x="${(sx0 + xEnd) / 2}" y="40" class="dg-label" text-anchor="middle">SIDE VIEW</text>
    <rect x="${sx0}" y="${scy - Hh}" width="${headLenPx}" height="${2 * Hh}" class="dg-edge"/>
    <rect x="${xHeadEnd}" y="${scy - Sh}" width="${shankLenPx}" height="${2 * Sh}" class="dg-thread"/>
    ${line(sx0 - 16, scy, xEnd + 16, scy, 'dg-center')}`;

  const secDimY = scy - Hh - 30;
  const lengthDim = `
    ${line(sx0, scy - Hh - 6, sx0, secDimY - 6, 'dg-ext')}
    ${line(xEnd, scy - Sh - 6, xEnd, secDimY - 6, 'dg-ext')}
    ${line(sx0, secDimY, xEnd, secDimY, 'dg-dimline')}
    ${arrow(sx0, secDimY, 'l')}${arrow(xEnd, secDimY, 'r')}
    ${dimText((sx0 + xEnd) / 2, secDimY - 8, `${len.text} LG`)}`;

  const diaDimX = xEnd + 30;
  const diaDim = `
    ${line(xEnd, scy - Sh, diaDimX + 4, scy - Sh, 'dg-ext')}
    ${line(xEnd, scy + Sh, diaDimX + 4, scy + Sh, 'dg-ext')}
    ${line(diaDimX, scy - Sh, diaDimX, scy + Sh, 'dg-dimline')}
    ${arrow(diaDimX, scy - Sh, 'u')}${arrow(diaDimX, scy + Sh, 'd')}
    <text x="${diaDimX + 8}" y="${scy + 4}" class="dg-dim" text-anchor="start">⌀${esc(dia.text)}</text>`;

  const headDimX = Math.max(16, sx0 - 40);
  const headDim = headD
    ? `
    ${line(sx0 - 6, scy - Hh, headDimX + 4, scy - Hh, 'dg-ext')}
    ${line(sx0 - 6, scy + Hh, headDimX + 4, scy + Hh, 'dg-ext')}
    ${line(headDimX, scy - Hh, headDimX, scy + Hh, 'dg-dimline')}
    ${arrow(headDimX, scy - Hh, 'u')}${arrow(headDimX, scy + Hh, 'd')}
    <text x="${headDimX - 8}" y="${scy + 4}" class="dg-dim" text-anchor="end">${esc(headD.text)}</text>`
    : '';

  const tbY = 462;
  const threadCallout = threadClassText ? `THREAD ${threadClassText}` : null;
  const tbItems = [opts.itemName ?? 'SCREW', material, threadCallout].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-thread { stroke: var(--ink); stroke-width: 1.8; fill: url(#dg-thread); }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${defs}${unitTag}${sideView}${lengthDim}${diaDim}${headDim}${title}
</svg>`;
}

// --- Helical compression spring ----------------------------------------
// A coiled wire: wire diameter, outside (coil) diameter, and free length
// are required; total coil count is optional (FLIS doesn't always carry
// it — a representative 8-coil profile is drawn when it's absent). Drawn
// as a simplified schematic zig-zag coil profile bounded by free length x
// outside diameter, the standard shorthand for a compression spring in a
// reference drawing. Wire diameter isn't legible at this scale, so it's
// called out with a leader — same leader convention as
// buildFlangedBearingDiagram / buildSleeveDiagram's end-view labels.
export function buildSpringDiagram(
  entries: CharacteristicEntry[],
  opts: { nsnDashed: string; itemName: string | null }
): string | null {
  const wireD = findDim(entries, [/\bWIRE DIAMETER\b/i, /\bWIRE SIZE\b/i]);
  const od = findDim(entries, [/\bOUTSIDE DIAMETER\b/i, /\bCOIL (?:OUTSIDE )?DIAMETER\b/i]);
  const freeLen = findDim(entries, [/\bFREE LENGTH\b/i, /\bOVERALL LENGTH\b/i, /\bLENGTH\b/i]);
  if (!wireD || !od || !freeLen) return null;
  if (!(od.mid > wireD.mid * 1.5)) return null; // OD must clear room for a coil lumen
  if (!(freeLen.mid > wireD.mid)) return null;

  const coils = findDim(entries, [/\b(?:TOTAL |NUMBER OF )?COILS\b/i]);
  const material = findText(entries, [/^MATERIAL$/i, /MATERIAL DOCUMENT/i]);
  const unit = detectUnit(entries);

  const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
  const arrow = (x: number, y: number, dir: 'l' | 'r' | 'u' | 'd') => {
    const d = 7, w = 2.6;
    const p = dir === 'l' ? `${x},${y} ${x + d},${y - w} ${x + d},${y + w}`
      : dir === 'r' ? `${x},${y} ${x - d},${y - w} ${x - d},${y + w}`
      : dir === 'u' ? `${x},${y} ${x - w},${y + d} ${x + w},${y + d}`
      : `${x},${y} ${x - w},${y - d} ${x + w},${y - d}`;
    return `<polygon points="${p}" class="dg-fill"/>`;
  };
  const dimText = (x: number, y: number, t: string, anchor = 'middle') =>
    `<text x="${x}" y="${y}" class="dg-dim" text-anchor="${anchor}">${esc(t)}</text>`;

  // ---- Side profile: zig-zag coil symbol bounded by free length x OD ----
  const scale = Math.min(430 / freeLen.mid, 90 / od.mid);
  const L = freeLen.mid * scale;
  const halfOD = Math.max(16, (od.mid / 2) * scale);
  const sx0 = 60, scy = 175;
  const xEnd = sx0 + L;
  const nCoils = coils && coils.mid >= 2 ? Math.max(3, Math.min(24, Math.round(coils.mid))) : 8;
  const segs = nCoils * 2;
  const dx = L / segs;
  const pts: string[] = [];
  for (let k = 0; k <= segs; k++) {
    const x = sx0 + k * dx;
    const y = k % 2 === 0 ? scy - halfOD : scy + halfOD;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const coilProfile = `
    <text x="${(sx0 + xEnd) / 2}" y="40" class="dg-label" text-anchor="middle">SIDE VIEW</text>
    <polyline points="${pts.join(' ')}" class="dg-edge" fill="none"/>
    ${line(sx0 - 16, scy, xEnd + 16, scy, 'dg-center')}`;

  const secDimY = scy - halfOD - 30;
  const lengthDim = `
    ${line(sx0, scy - halfOD - 6, sx0, secDimY - 6, 'dg-ext')}
    ${line(xEnd, scy - halfOD - 6, xEnd, secDimY - 6, 'dg-ext')}
    ${line(sx0, secDimY, xEnd, secDimY, 'dg-dimline')}
    ${arrow(sx0, secDimY, 'l')}${arrow(xEnd, secDimY, 'r')}
    ${dimText((sx0 + xEnd) / 2, secDimY - 8, `${freeLen.text} FREE LG`)}`;

  const odDimX = xEnd + 30;
  const odDim = `
    ${line(xEnd, scy - halfOD, odDimX + 4, scy - halfOD, 'dg-ext')}
    ${line(xEnd, scy + halfOD, odDimX + 4, scy + halfOD, 'dg-ext')}
    ${line(odDimX, scy - halfOD, odDimX, scy + halfOD, 'dg-dimline')}
    ${arrow(odDimX, scy - halfOD, 'u')}${arrow(odDimX, scy + halfOD, 'd')}
    <text x="${odDimX + 8}" y="${scy + 4}" class="dg-dim" text-anchor="start">⌀${esc(od.text)} O.D.</text>`;

  const leaderX1 = sx0 + dx, leaderY1 = scy + halfOD;
  const leaderX2 = leaderX1 + 40, leaderY2 = leaderY1 + 40;
  const wireDim = `
    ${line(leaderX1, leaderY1, leaderX2 - 4, leaderY2, 'dg-ext')}
    <circle cx="${leaderX1}" cy="${leaderY1}" r="1.6" class="dg-fill"/>
    <text x="${leaderX2}" y="${leaderY2 + 1}" class="dg-note" text-anchor="start">WIRE DIA</text>
    <text x="${leaderX2}" y="${leaderY2 + 14}" class="dg-dim" text-anchor="start">⌀${esc(wireD.text)}</text>`;

  const tbY = 462;
  const tbItems = [
    opts.itemName ?? 'COMPRESSION SPRING',
    material,
    coils ? `${coils.text.replace(/–.*/, '')} COILS (ref)` : null,
  ].filter(Boolean) as string[];
  const style = `<style>
    .dg-edge { stroke: var(--ink); stroke-width: 1.8; fill: none; }
    .dg-ext, .dg-dimline { stroke: var(--ink-soft); stroke-width: 1; }
    .dg-center { stroke: var(--ink-soft); stroke-width: 0.9; stroke-dasharray: 14 4 3 4; }
    .dg-fill { fill: var(--ink-soft); }
    .dg-dim, .dg-label, .dg-note, .dg-title { font-family: "IBM Plex Mono", monospace; fill: var(--ink); }
    .dg-dim { font-size: 13px; }
    .dg-label { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; }
    .dg-note { font-size: 10px; fill: var(--ink-soft); letter-spacing: 0.03em; }
    .dg-title { font-size: 15px; font-weight: 600; letter-spacing: 0.06em; }
  </style>`;
  const title = `
    ${line(28, tbY - 18, 732, tbY - 18, 'dg-edge')}
    <text x="28" y="${tbY + 2}" class="dg-title">${esc(opts.nsnDashed)}</text>
    <text x="732" y="${tbY + 2}" class="dg-note" text-anchor="end">ALL DIMENSIONS IN ${unit.long} · REFERENCE ONLY, NOT FOR MANUFACTURE</text>
    <text x="28" y="${tbY + 22}" class="dg-note">${esc(tbItems.join('  ·  '))}</text>`;

  const unitTag = `<text x="732" y="30" class="dg-note" text-anchor="end">UNITS: ${unit.long}</text>`;
  return `<svg viewBox="0 0 760 505" role="img" aria-label="Dimensioned drawing of ${esc(opts.nsnDashed)} (${unit.long})" xmlns="http://www.w3.org/2000/svg">
  ${style}${unitTag}${coilProfile}${lengthDim}${odDim}${wireDim}${title}
</svg>`;
}

// --- Product-card thumbnails ------------------------------------------
// Small, undimensioned silhouettes for grid/card use (product-card image
// slot). No title block, no labels, no units — just the primary shape,
// scaled to a 120x120 viewBox so it stays recognizable at thumbnail size.
// Reuses the same characteristic-parsing helpers as the full drawings so
// the silhouette is geometrically consistent with the detail-page diagram.
// Returns null when the characteristics don't carry enough geometry for
// the given FSC's shape.

const THUMB_STROKE = 'stroke="var(--ink)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"';

function thumbWrap(body: string): string {
  return `<svg viewBox="0 0 120 120" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

function thumbCircle(cx: number, cy: number, r: number): string {
  return `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${Math.max(0.5, r).toFixed(2)}" ${THUMB_STROKE}/>`;
}

/**
 * Two-concentric-circle tube silhouette (outside diameter + bore), shared
 * by the flat-washer and sleeve/spacer/bushing thumbnails — they're the
 * same shape at thumbnail scale, just different FLIS requirement labels.
 */
function thumbTube(entries: CharacteristicEntry[], odPats: RegExp[], idPats: RegExp[]): string | null {
  const od = findDim(entries, odPats);
  const id = findDim(entries, idPats);
  if (!od || !id || !(od.mid > id.mid)) return null;
  const scale = 50 / (od.mid / 2);
  const R = (od.mid / 2) * scale;
  const r = Math.max(8, (id.mid / 2) * scale);
  return thumbWrap(`${thumbCircle(60, 60, R)}${thumbCircle(60, 60, r)}`);
}

/** Flat-top hexagon + central bore circle, true relative proportion. */
function thumbNut(entries: CharacteristicEntry[]): string | null {
  const waf = findDim(entries, [/\bWIDTH ACROSS FLATS\b/i, /\bACROSS FLATS\b/i]);
  if (!waf || !(waf.mid > 0)) return null;
  const thread = findDim(entries, [/\bNOMINAL THREAD (?:DIAMETER|SIZE)\b/i, /\bTHREAD SIZE\b/i, /\bTHREAD CLASS\b/i]);

  const cx = 60, cy = 60;
  const apothem = 44; // fixed paper half-height across flats
  const R = apothem / Math.cos(Math.PI / 6);
  const scale = (apothem * 2) / waf.mid;
  const hexPts = [-120, -60, 0, 60, 120, 180]
    .map((deg) => {
      const a = (deg * Math.PI) / 180;
      return `${(cx + R * Math.cos(a)).toFixed(2)},${(cy + R * Math.sin(a)).toFixed(2)}`;
    })
    .join(' ');
  const rThread =
    thread && thread.mid > 0 ? Math.max(4, Math.min(apothem * 0.75, (thread.mid / 2) * scale)) : apothem * 0.35;
  return thumbWrap(`<polygon points="${hexPts}" ${THUMB_STROKE}/>${thumbCircle(cx, cy, rThread)}`);
}

/** Rounded-rectangle (capsule) silhouette for a straight pin / dowel. */
function thumbPin(entries: CharacteristicEntry[]): string | null {
  const dia = findDim(entries, [/\bDIAMETER\b/i, /\bPIN DIAMETER\b/i, /\bSHANK DIAMETER\b/i, /\bNOMINAL DIAMETER\b/i]);
  const len = findDim(entries, [/\bOVERALL LENGTH\b/i, /\bLENGTH\b/i, /\bPIN LENGTH\b/i]);
  if (!dia || !len || !(len.mid > dia.mid)) return null;

  const maxW = 96, maxH = 40;
  const scale = Math.min(maxW / len.mid, maxH / dia.mid);
  const w = Math.max(24, len.mid * scale);
  const h = Math.max(8, Math.min(maxH, dia.mid * scale));
  const x = 60 - w / 2, y = 60 - h / 2;
  return thumbWrap(
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${(h / 2).toFixed(2)}" ${THUMB_STROKE}/>`
  );
}

/** Head-rectangle + shank-rectangle silhouette for a screw/bolt/stud. */
function thumbScrew(entries: CharacteristicEntry[]): string | null {
  const dia = findDim(entries, [
    /\bNOMINAL THREAD (?:DIAMETER|SIZE)\b/i,
    /\bTHREAD SIZE\b/i,
    /\bNOMINAL DIAMETER\b/i,
    /\bSHANK DIAMETER\b/i,
  ]);
  const len = findDim(entries, [/\b(?:OVERALL |NOMINAL )?LENGTH\b/i, /\bFASTENER LENGTH\b/i]);
  if (!dia || !len || !(len.mid > dia.mid)) return null;
  let headD = findDim(entries, [/\bHEAD (?:DIAMETER|WIDTH|HEIGHT)\b/i, /\bWIDTH ACROSS FLATS\b/i]);
  if (headD && !(headD.mid > dia.mid)) headD = null;

  const headDiaReal = headD ? headD.mid : dia.mid * 1.6;
  const headLenReal = Math.min(dia.mid * 0.75, len.mid * 0.3);
  const shankLenReal = Math.max(dia.mid * 0.2, len.mid - headLenReal);
  const totalReal = headLenReal + shankLenReal;

  const maxW = 96, maxH = 40;
  const scale = Math.min(maxW / totalReal, maxH / headDiaReal);
  const headLenPx = headLenReal * scale;
  const shankLenPx = shankLenReal * scale;
  const totalPx = headLenPx + shankLenPx;
  const Hh = Math.max(6, (headDiaReal / 2) * scale);
  const Sh = Math.max(3, Math.min(Hh - 1, (dia.mid / 2) * scale));
  const x0 = 60 - totalPx / 2;
  const xHeadEnd = x0 + headLenPx;
  const xEnd = x0 + totalPx;
  return thumbWrap(
    `<rect x="${x0.toFixed(2)}" y="${(60 - Hh).toFixed(2)}" width="${headLenPx.toFixed(2)}" height="${(2 * Hh).toFixed(2)}" ${THUMB_STROKE}/>
     <rect x="${xHeadEnd.toFixed(2)}" y="${(60 - Sh).toFixed(2)}" width="${(xEnd - xHeadEnd).toFixed(2)}" height="${(2 * Sh).toFixed(2)}" ${THUMB_STROKE}/>`
  );
}

/** A few zig-zag coil loops for a compression-spring card thumbnail. */
function thumbSpring(entries: CharacteristicEntry[]): string | null {
  const wireD = findDim(entries, [/\bWIRE DIAMETER\b/i, /\bWIRE SIZE\b/i]);
  const od = findDim(entries, [/\bOUTSIDE DIAMETER\b/i, /\bCOIL (?:OUTSIDE )?DIAMETER\b/i]);
  const freeLen = findDim(entries, [/\bFREE LENGTH\b/i, /\bOVERALL LENGTH\b/i, /\bLENGTH\b/i]);
  if (!wireD || !od || !freeLen) return null;
  if (!(od.mid > wireD.mid * 1.5) || !(freeLen.mid > wireD.mid)) return null;

  const maxW = 96, maxH = 60;
  const scale = Math.min(maxW / freeLen.mid, maxH / od.mid);
  const L = Math.max(24, freeLen.mid * scale);
  const halfOD = Math.max(8, Math.min(maxH / 2, (od.mid / 2) * scale));
  const x0 = 60 - L / 2;
  const nCoils = 5;
  const segs = nCoils * 2;
  const dx = L / segs;
  const pts: string[] = [];
  for (let k = 0; k <= segs; k++) {
    const x = x0 + k * dx;
    const y = k % 2 === 0 ? 60 - halfOD : 60 + halfOD;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return thumbWrap(`<polyline points="${pts.join(' ')}" ${THUMB_STROKE}/>`);
}

// Full dimensioned drawing, dispatched by FSC archetype. Returns null when the
// FSC has no archetype OR the specs lack the geometry a drawing needs — so a
// drawing renders on every page whose specs support one, and never a wrong one.
// New part families are added here (plus their generator above) as archetypes.
export function buildDiagram(
  entries: CharacteristicEntry[],
  fsc: string,
  opts: { nsnDashed: string; itemName: string | null },
): string | null {
  const name = (opts.itemName ?? '').toUpperCase();
  if (fsc === '3120') return buildFlangedBearingDiagram(entries, opts) ?? buildSleeveDiagram(entries, opts);
  if (fsc === '5310') {
    if (/WASHER/.test(name)) return buildWasherDiagram(entries, opts);
    const plateNut = buildPlateNutDiagram(entries, opts);
    if (plateNut) return plateNut;
    return /NUT/.test(name) ? buildNutDiagram(entries, opts) : null;
  }
  if (fsc === '5305' || fsc === '5306' || fsc === '5307') return buildScrewDiagram(entries, opts);
  if (fsc === '5315') return buildPinDiagram(entries, opts);
  if (fsc === '5330' || fsc === '5331') return buildRingDiagram(entries, opts);
  if (fsc === '5360') return buildSpringDiagram(entries, opts);
  if (fsc === '5365') return buildSleeveDiagram(entries, opts);
  return null;
}

export function buildThumbnail(entries: CharacteristicEntry[], fsc: string, itemName?: string | null): string | null {
  const cx = 60;
  const cy = 60;
  const name = (itemName ?? '').toUpperCase();

  // FSC 3120 — flanged sleeve bearings get an end-view silhouette with
  // three concentric circles (flange OD, body OD, bore); plain
  // bushings/sleeves in the same FSC that don't carry flange dimensions
  // fall back to the two-circle tube silhouette (OD, bore).
  if (fsc === '3120') {
    const g = (pat: RegExp) => {
      const e = entries.find((x) => x.requirement && pat.test(x.requirement));
      return e ? parseDimAll(e.reply) : null;
    };
    const bodyOD = g(/BODY OUTSIDE DIAMETER/i);
    const bodyID = g(/BODY INSIDE DIAMETER|BORE/i);
    const flangeOD = g(/FLANGE OUTSIDE DIAMETER/i);
    if (bodyOD && bodyID && flangeOD && flangeOD.mid > bodyOD.mid && bodyOD.mid > bodyID.mid) {
      const scale = 50 / (flangeOD.mid / 2);
      const rFlange = (flangeOD.mid / 2) * scale;
      const rBody = (bodyOD.mid / 2) * scale;
      const rBore = Math.max(6, (bodyID.mid / 2) * scale);
      return thumbWrap(`${thumbCircle(cx, cy, rFlange)}${thumbCircle(cx, cy, rBody)}${thumbCircle(cx, cy, rBore)}`);
    }
    return thumbTube(
      entries,
      [/\bOUTSIDE DIAMETER\b/i, /\bBODY OUTSIDE DIAMETER\b/i, /\bOUTER DIAMETER\b/i, /\bOD\b/i],
      [/\bINSIDE DIAMETER\b/i, /\bBORE\b/i, /\bINTERNAL DIAMETER\b/i, /\bINNER DIAMETER\b/i, /\bID\b/i]
    );
  }

  // FSC 5310 — washers, plain/hex nuts, and plate/anchor nuts share this
  // FSC, dispatched by item name (washer first; then the existing
  // plate/anchor-nut obround silhouette; plain-nut hexagon as the
  // fallback for hex nuts that aren't two-lug anchor nuts).
  if (fsc === '5310') {
    if (/WASHER/.test(name)) {
      return thumbTube(
        entries,
        [/\bOUTSIDE DIAMETER\b/i, /\bWASHER OUTSIDE DIAMETER\b/i, /\bOUTER DIAMETER\b/i, /\bOD\b/i],
        [/\bINSIDE DIAMETER\b/i, /\bBORE DIAMETER\b/i, /\bNOMINAL (?:INSIDE )?DIAMETER\b/i, /\bINNER DIAMETER\b/i, /\bID\b/i, /\bBORE\b/i]
      );
    }

    const g = (pat: RegExp) => {
      const e = entries.find((x) => x.requirement && pat.test(x.requirement));
      return e ? parseDimAll(e.reply) : null;
    };
    const len = g(/NUT LENGTH|OVERALL LENGTH/i);
    const width = g(/PLATE WIDTH|NUT WIDTH/i);
    const c2c = g(/CENTER TO CENTER DISTANCE BETWEEN MOUNTING HOLES/i);
    const holeD = g(/MOUNTING HOLE DIAMETER/i);
    const thread = g(/NOMINAL THREAD SIZE/i);
    if (len && width && c2c && holeD) {
      const scale = Math.min(96 / len.mid, 56 / width.mid);
      const L = len.mid * scale;
      const W = Math.max(22, width.mid * scale);
      const half = (c2c.mid / 2) * scale;
      const rHole = Math.max(2.5, (holeD.mid / 2) * scale);
      const rCenter = thread ? Math.max(4, (thread.mid / 2) * scale) : Math.max(7, W * 0.2);
      const capR = W / 2;
      const xL = cx - L / 2;
      const xR = cx + L / 2;
      if (L > 2 * capR) {
        // obround needs straight sides to draw sanely
        const plate = `M ${(xL + capR).toFixed(2)} ${(cy - W / 2).toFixed(2)}
          L ${(xR - capR).toFixed(2)} ${(cy - W / 2).toFixed(2)}
          A ${capR.toFixed(2)} ${capR.toFixed(2)} 0 0 1 ${(xR - capR).toFixed(2)} ${(cy + W / 2).toFixed(2)}
          L ${(xL + capR).toFixed(2)} ${(cy + W / 2).toFixed(2)}
          A ${capR.toFixed(2)} ${capR.toFixed(2)} 0 0 1 ${(xL + capR).toFixed(2)} ${(cy - W / 2).toFixed(2)} Z`;
        const body = `<path d="${plate}" ${THUMB_STROKE}/>
          ${thumbCircle(cx, cy, rCenter)}
          ${thumbCircle(cx - half, cy, rHole)}
          ${thumbCircle(cx + half, cy, rHole)}`;
        return thumbWrap(body);
      }
    }

    return /NUT/.test(name) ? thumbNut(entries) : null;
  }

  // FSC 5305/5306/5307 — screws, bolts, studs: head + shank silhouette.
  if (fsc === '5305' || fsc === '5306' || fsc === '5307') return thumbScrew(entries);

  // FSC 5315 — straight pins / dowels: capsule silhouette.
  if (fsc === '5315') return thumbPin(entries);

  // FSC 5360 — helical compression springs: coil silhouette.
  if (fsc === '5360') return thumbSpring(entries);

  // FSC 5365 — sleeves, spacers, plain bushings: two-circle tube silhouette.
  if (fsc === '5365') {
    return thumbTube(
      entries,
      [/\bOUTSIDE DIAMETER\b/i, /\bBODY OUTSIDE DIAMETER\b/i, /\bOUTER DIAMETER\b/i, /\bOD\b/i],
      [/\bINSIDE DIAMETER\b/i, /\bBORE\b/i, /\bINTERNAL DIAMETER\b/i, /\bINNER DIAMETER\b/i, /\bID\b/i]
    );
  }

  // Ring FSCs (5331 packings, 5330 gaskets/seals) — o-ring silhouette:
  // two concentric circles (OD, ID), derived from cross-section when only
  // one diameter is on file.
  if (fsc === '5331' || fsc === '5330') {
    const odE = pick(entries, ['ABHE'], /\bOUTSIDE DIAMETER\b|\bOUTER DIAMETER\b|\bOD\b/i);
    const idE = pick(entries, ['ADYT', 'ABHP'], /(CENTER HOLE|INSIDE|INNER) DIAMETER|\bID\b|\bBORE\b/i);
    const csE = pick(entries, ['ADVN', 'ABKW'], /CROSS[- ]SECTION|SECTION DIAMETER/i);
    const od0 = parseInches(odE?.reply ?? null);
    const id0 = parseInches(idE?.reply ?? null);
    const cs = parseInches(csE?.reply ?? null);
    if (!cs || (!od0 && !id0)) return null;

    const odMid = od0 ? od0.mid : id0!.mid + 2 * cs.mid;
    const idMid = id0 ? id0.mid : Math.max(0, od0!.mid - 2 * cs.mid);
    if (!(odMid > idMid)) return null;

    const scale = 50 / (odMid / 2);
    const R = (odMid / 2) * scale;
    const r = Math.max(8, (idMid / 2) * scale);
    return thumbWrap(`${thumbCircle(cx, cy, R)}${thumbCircle(cx, cy, r)}`);
  }

  return null;
}
