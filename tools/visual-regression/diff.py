"""Pixel-diff two screenshot dirs. usage: diff.py <a> <b> [diff_out]
Prints one line per differing file with the bounding box of the changed pixels and, for small
regions, base64 crops (A then B). A pixel counts as different when any channel differs by more than 8."""
import sys, os, json, glob
import numpy as np
from PIL import Image

A, B = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else None
if OUT:
    os.makedirs(OUT, exist_ok=True)
def reports(d):
    out = {}
    for f in glob.glob(os.path.join(d, 'report*.json')):
        out.update(json.load(open(f)))
    return out
RA, RB = reports(A), reports(B)
rows, fail, explained = [], 0, 0
for f in sorted(os.listdir(A)):
    if not f.endswith('.png'):
        continue
    pa, pb = os.path.join(A, f), os.path.join(B, f)
    if not os.path.exists(pb):
        rows.append((f, 'MISSING', '', '')); fail += 1; continue
    a, b = Image.open(pa).convert('RGB'), Image.open(pb).convert('RGB')
    if a.size != b.size:
        # Different heights: say where the first difference from the top and from the bottom is, so the
        # changed region (between them) can be named.
        if a.size[0] == b.size[0]:
            na, nb = np.asarray(a, dtype=np.int16), np.asarray(b, dtype=np.int16)
            h = min(na.shape[0], nb.shape[0])
            top = np.where((np.abs(na[:h] - nb[:h]).max(axis=2) > 8).any(axis=1))[0]
            bot = np.where((np.abs(na[-h:][::-1] - nb[-h:][::-1]).max(axis=2) > 8).any(axis=1))[0]
            rows.append((f, f'SIZE {a.size} vs {b.size}', f'first diff from top y={int(top[0]) if len(top) else None}',
                         f'first diff from bottom (A rows) y={a.size[1] - 1 - int(bot[0]) if len(bot) else None}'))
        else:
            rows.append((f, f'SIZE {a.size} vs {b.size}', '', ''))
        fail += 1; continue
    d = np.abs(np.asarray(a, dtype=np.int16) - np.asarray(b, dtype=np.int16)).max(axis=2)
    n = int((d > 8).sum())
    if n == 0:
        rows.append((f, 'identical', 0, '')); continue
    ys, xs = np.where(d > 8)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    key = os.path.splitext(f)[0]
    inside = False
    for rep in (RA, RB):
        fn = (rep.get(key) or {}).get('fn')
        if fn and bbox[0] >= fn[0] - 4 and bbox[2] <= fn[0] + fn[2] + 4 and bbox[1] >= fn[1] - 4 and bbox[3] <= fn[1] + fn[3] + 4:
            inside = True
    rows.append((f, 'DIFF-footer-links-only' if inside else 'DIFF', n, bbox)); fail += 1
    if n < 50 and not inside:  # tiny differences: show the changed pixels so the cause can be read from the log
        ys2, xs2 = np.where(d > 8)
        print('   changed pixels of', f, [(int(x), int(y), tuple(int(v) for v in np.asarray(a)[y, x]), tuple(int(v) for v in np.asarray(b)[y, x])) for y, x in list(zip(ys2, xs2))[:6]])
    if inside:
        explained += 1
    # Bands of changed rows (gap > 40px starts a new band) with their x extent, for explaining each region.
    rowsd = np.where((d > 8).any(axis=1))[0]
    bands, start, prev = [], int(rowsd[0]), int(rowsd[0])
    for y in map(int, rowsd[1:]):
        if y - prev > 40:
            bands.append((start, prev)); start = y
        prev = y
    bands.append((start, prev))
    for (y0, y1) in ([] if inside else bands[:6]):
        xs2 = np.where((d[y0:y1 + 1] > 8).any(axis=0))[0]
        print(f'   {f} band y={y0}-{y1} x={int(xs2.min())}-{int(xs2.max())} of {a.size[0]}x{a.size[1]}')
    if OUT:
        Image.fromarray(((d > 8) * 255).astype('uint8')).save(os.path.join(OUT, f))
for r in rows:
    if r[1] != 'identical':
        print(*r)
print(f'{len(rows)} compared, {len(rows) - fail} identical, {fail} differing, of which {explained} lie entirely inside the footer link row (the new Contact link)')
print(f'unexplained by the footer link: {fail - explained} (new or edited pages are listed above as SIZE or DIFF)')
