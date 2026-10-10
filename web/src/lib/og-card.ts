// Share cards (1200 x 630 PNG), drawn at BUILD TIME with sharp (installed with
// Astro as its image library; add it to web/package.json if Astro ever stops
// bringing it). Never import
// this from an on-demand route: sharp is a native module and does not run in
// the Worker. The logo comes from the generated lib/logo.ts; text is set in
// the Inter subset kept in brand/fonts so the result is the same on any
// machine, with or without Inter installed.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { LOCKUP, MARK } from './logo';

const W = 1200;
const H = 630;
const INK = '#111114';
const PAPER = '#FAF8F3';
const SOFT = '#B9B7B0';
const GREEN = '#1FB866';
const PAD = 72;

const fontPath = (name: string): string => fileURLToPath(new URL(`../../../brand/fonts/${name}`, import.meta.url));
const FONTS = {
  regular: { font: 'Inter', fontfile: fontPath('Inter-Regular.otf') },
  semibold: { font: 'Inter Semi-Bold', fontfile: fontPath('Inter-SemiBold.otf') },
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface TextSpec {
  text: string;
  size: number;
  color: string;
  weight?: keyof typeof FONTS;
  /** Wrap width in px. Omit for a single line. */
  width?: number;
  /** Letter spacing in px. */
  tracking?: number;
}
interface Rendered {
  input: Buffer;
  width: number;
  height: number;
}

async function text(spec: TextSpec): Promise<Rendered> {
  const f = FONTS[spec.weight ?? 'regular'];
  const attrs = [
    `foreground="${spec.color}"`,
    `size="${spec.size}pt"`,
    'line_height="1.12"',
    spec.tracking ? `letter_spacing="${Math.round(spec.tracking * 1024)}"` : '',
  ].join(' ');
  const { data, info } = await sharp({
    text: { text: `<span ${attrs}>${esc(spec.text)}</span>`, ...f, rgba: true, dpi: 72, ...(spec.width ? { width: spec.width, wrap: 'word' as const } : {}) },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

const TITLE_MAX_H = 190; // room between the eyebrow and the figures

/** The largest size at which the title fits the width and the room above the figures. */
async function fitTitle(title: string, width: number): Promise<Rendered> {
  let last: Rendered | null = null;
  for (const size of [76, 66, 58, 50, 44, 38]) {
    last = await text({ text: title, size, color: PAPER, weight: 'semibold', width });
    if (last.height <= TITLE_MAX_H) return last;
  }
  return last as Rendered;
}

const colour = (body: string, main: string, accent: string): string =>
  body.replaceAll('var(--logo-accent, currentColor)', accent).replaceAll('currentColor', main);

function backdrop(): Buffer {
  const lockupH = 46;
  const lockupW = (lockupH * LOCKUP.w) / LOCKUP.h;
  const ghost = 760;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="${INK}"/>` +
      `<svg x="${W - ghost * 0.62}" y="${(H - ghost) / 2}" width="${(ghost * MARK.w) / MARK.h}" height="${ghost}" viewBox="${MARK.viewBox}" opacity="0.05">${colour(MARK.body, PAPER, PAPER)}</svg>` +
      `<svg x="${PAD}" y="${PAD - 8}" width="${lockupW}" height="${lockupH}" viewBox="${LOCKUP.viewBox}">${colour(LOCKUP.body, PAPER, GREEN)}</svg>` +
      `</svg>`,
  );
}

export interface CardStat {
  value: string;
  label: string;
}
export interface CardSpec {
  /** Small green line above the title, e.g. "Federal supply class 5330". */
  eyebrow: string;
  title: string;
  /** Up to three figures. */
  stats: CardStat[];
  /** ISO date the figures are from. */
  asOf: string;
}

const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export async function renderCard(spec: CardSpec): Promise<Buffer> {
  const layers: sharp.OverlayOptions[] = [];
  const put = (r: Rendered, left: number, top: number): void => {
    layers.push({ input: r.input, left: Math.round(left), top: Math.round(top) });
  };

  const eyebrow = await text({ text: spec.eyebrow.toUpperCase(), size: 22, color: GREEN, weight: 'semibold', tracking: 2.5 });
  put(eyebrow, PAD, 168);

  const title = await fitTitle(spec.title, W - PAD * 2 - 120);
  put(title, PAD, 168 + eyebrow.height + 14);

  const stats = spec.stats.slice(0, 3);
  const colW = (W - PAD * 2) / 3;
  const statTop = 418;
  for (const [i, s] of stats.entries()) {
    const value = await text({ text: s.value, size: 60, color: PAPER, weight: 'semibold' });
    const label = await text({ text: s.label, size: 23, color: SOFT, width: Math.round(colW - 28) });
    put(value, PAD + i * colW, statTop);
    put(label, PAD + i * colW, statTop + 74); // fixed, so labels line up whatever the digits
  }

  const site = await text({ text: 'nsnexplorer.com', size: 22, color: SOFT, weight: 'semibold' });
  const date = await text({ text: `Public records as of ${longDate(spec.asOf)}`, size: 22, color: SOFT });
  put(site, PAD, H - 44 - site.height);
  put(date, W - PAD - date.width, H - 44 - date.height);

  return sharp(backdrop()).composite(layers).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
}

export const pngResponse = (png: Buffer): Response =>
  new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
