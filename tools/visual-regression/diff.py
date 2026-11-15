"""Pixel-diff two screenshot dirs. usage: diff.py <a> <b> [diff_out]
Prints one line per differing file with the bounding box of the changed pixels and, for small
regions, base64 crops (A then B). A pixel counts as different when any channel differs by more than 8."""
import sys, os
import numpy as np
from PIL import Image

A, B = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else None
if OUT:
    os.makedirs(OUT, exist_ok=True)
rows, fail = [], 0
for f in sorted(os.listdir(A)):
    if not f.endswith('.png'):
        continue
    pa, pb = os.path.join(A, f), os.path.join(B, f)
    if not os.path.exists(pb):
        rows.append((f, 'MISSING', '', '')); fail += 1; continue
    a, b = Image.open(pa).convert('RGB'), Image.open(pb).convert('RGB')
    if a.size != b.size:
        rows.append((f, f'SIZE {a.size} vs {b.size}', '', '')); fail += 1; continue
    d = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)).max(axis=2)
    n = int((d > 8).sum())
    if n == 0:
        rows.append((f, 'identical', 0, '')); continue
    ys, xs = np.where(d > 8)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    rows.append((f, 'DIFF', n, bbox)); fail += 1
    # Bands of changed rows (gap > 40px starts a new band) with their x extent, for explaining each region.
    rowsd = np.where((d > 8).any(axis=1))[0]
    bands, start, prev = [], int(rowsd[0]), int(rowsd[0])
    for y in map(int, rowsd[1:]):
        if y - prev > 40:
            bands.append((start, prev)); start = y
        prev = y
    bands.append((start, prev))
    for (y0, y1) in bands[:6]:
        xs2 = np.where((d[y0:y1 + 1] > 8).any(axis=0))[0]
        print(f'   {f} band y={y0}-{y1} x={int(xs2.min())}-{int(xs2.max())} of {a.size[0]}x{a.size[1]}')
    if OUT:
        Image.fromarray(((d > 8) * 255).astype('uint8')).save(os.path.join(OUT, f))
for r in rows:
    if r[1] != 'identical':
        print(*r)
print(f'{len(rows)} compared, {len(rows) - fail} identical, {fail} differing')
