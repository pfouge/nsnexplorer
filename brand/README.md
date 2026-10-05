# NSN Explorer logo

The compass nut: a hex nut with a compass needle in its bore.

`nsn-logo.mjs` is the only place the geometry lives. One unit `S`: the nut's ring is `S` at the flats,
the gap from needle tip to ring is `S`, the needle is a 60/120 rhombus tilted 30 degrees so every edge
runs parallel to a flat of the nut. Under about 48 px the small cut is used (heavier ring, larger
needle, no pivot). The lettering is drawn from the same circles and straight lines.

Colours: ink `#111114`, paper `#FAF8F3`, green `#0E7C4D` on light and `#1FB866` on dark. Green goes on
the needle only. The mark must work in one colour.

## Changing it

1. Edit `nsn-logo.mjs`.
2. `node brand/build.mjs` rewrites `web/public/favicon.svg`, `mark.svg`, `logo.svg` and
   `web/src/lib/logo.ts` (the inline header and footer logo).
3. `node brand/raster.mjs` redraws `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`,
   `icon-512.png` and `og-default.png`. It needs playwright and sharp (see the top of the file).
4. `node brand/build.mjs --check` fails if the generated files no longer match the source.

Never edit the generated files by hand.
