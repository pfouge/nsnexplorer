// Renders the PNG and ICO logo files and the share image with a real browser.
//   node brand/raster.mjs
// Needs playwright and sharp. They are not site dependencies; point BRAND_TOOLS at a node_modules
// folder that has them, e.g.  BRAND_TOOLS=/path/to/node_modules/ node brand/raster.mjs
// The share image uses Inter and IBM Plex Mono: installed copies if present, else Google Fonts.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INK, PAPER, GREEN_DK, tile, horizontal } from './nsn-logo.mjs';

const req = createRequire(process.env.BRAND_TOOLS || import.meta.url);
const { chromium } = req('playwright');
const sharp = req('sharp');
const out = (rel) => fileURLToPath(new URL('../web/public/' + rel, import.meta.url));

const browser = await chromium.launch();
async function shot(html, w, h, file) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${html}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  if (file) writeFileSync(out(file), buf);
  return buf;
}
const sized = (svg, px) => svg.replace('<svg ', `<svg width="${px}" height="${px}" `);

// Home-screen icons: full-bleed ink square (the OS rounds the corners), full mark inside the maskable safe zone.
const square = (px, ratio) => sized(tile({ size: px, small: false, radius: 0, fillRatio: ratio }), px);
await shot(square(180, 0.6), 180, 180, 'apple-touch-icon.png');
await shot(square(192, 0.56), 192, 192, 'icon-192.png');
await shot(square(512, 0.56), 512, 512, 'icon-512.png');

// favicon.ico for clients that ignore the SVG: 16, 32 and 48 px of the small-cut tile, PNG-encoded.
const pngs = [];
for (const px of [16, 32, 48]) pngs.push({ px, buf: await shot(sized(tile({ size: 32, small: true, fillRatio: 0.84 }), px), px, px) });
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach(({ px, buf }, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(px, e); head.writeUInt8(px, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});
writeFileSync(out('favicon.ico'), Buffer.concat([head, ...pngs.map((p) => p.buf)]));

// Share image, 1200 x 630.
const fonts = process.env.BRAND_FONT_CSS || `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400&family=IBM+Plex+Mono:wght@500&display=swap">`;
const lock = horizontal({ nut: PAPER, needle: GREEN_DK, word: PAPER }).svg.replace('<svg ', '<svg width="800" ');
const og = await shot(`${fonts}<div style="width:1200px;height:630px;background:${INK};display:flex;flex-direction:column;align-items:center;justify-content:center">
  ${lock}
  <div style="font:400 37px Inter,system-ui,sans-serif;color:#C9C7C0;margin-top:62px;letter-spacing:-0.005em">What the government actually paid, per part, with the receipts.</div>
  <div style="font:500 23px 'IBM Plex Mono',monospace;color:${GREEN_DK};margin-top:46px;letter-spacing:0.42em;margin-right:-0.42em">FREE · SOURCE-LINKED · NO ESTIMATES</div>
</div>`, 1200, 630);
await sharp(og).flatten({ background: INK }).png({ compressionLevel: 9 }).toFile(out('og-default.png'));

await browser.close();
console.log('wrote apple-touch-icon.png, icon-192.png, icon-512.png, favicon.ico, og-default.png');
