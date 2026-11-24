"""Summarises a design-audit run: one row per route, before (a) and after (b) side by side.
usage: summary.py <out_dir>"""
import sys, json, os
O = sys.argv[1]
def load(p):
    return json.load(open(p)) if os.path.exists(p) else {}
a, b = load(f'{O}/a/measure.json'), load(f'{O}/b/measure.json')
cmp = load(f'{O}/compare.json')
base = a or b
print('| route | screens 390 | screens 1280 | answer at (screens, 390) | longest table | CLS max | overflow widths | compare |')
print('|---|---|---|---|---|---|---|---|')
def cell(m, k):
    return '' if not m or k not in m else m[k]
for r in base:
    def side(d, w, k):
        return cell(d.get(r, {}).get(w, {}), k)
    row = []
    for w in ('390', '1280'):
        row.append(f"{side(a, w, 'screens')} → {side(b, w, 'screens')}" if a else f"{side(b, w, 'screens')}")
    ans = f"{side(a, '390', 'firstAnswerScreens')} → {side(b, '390', 'firstAnswerScreens')}" if a else side(b, '390', 'firstAnswerScreens')
    lt = side(b, '1280', 'longestTable')
    cls = max([float(cell(b.get(r, {}).get(w, {}), 'cls') or 0) for w in ('390', '768', '1280')] or [0])
    ov = b.get(r, {}).get('sweep_overflow', [])
    c = cmp.get(r, {})
    st = ('FAIL ' + '; '.join(c['fail'])[:160]) if c.get('fail') else ('warn' if c.get('warn') else 'ok')
    ws = [w for w, _ in ov if isinstance(w, int)]
    rng = []
    for w in ws:
        if rng and w - rng[-1][1] == 10: rng[-1][1] = w
        else: rng.append([w, w])
    ovs = ','.join(f'{a}-{b}' if a != b else f'{a}' for a, b in rng) or '0'
    print(f"| {r} | {row[0]} | {row[1]} | {ans} | {lt} | {cls:.3f} | {ovs} | {st} |")

print()
print('## Accessibility (axe WCAG 2 A/AA at 1280; keyboard focus ring over 25 Tab stops)')
for r in base:
    a = b.get(r, {}).get('a11y')
    if not a: continue
    if 'error' in a: print(f'- {r}: error {a["error"]}'); continue
    v = a.get('axe', []); nr = a.get('no_ring', [])
    if v or nr:
        print(f'- {r}: ' + '; '.join(f"{x['id']} ({x['impact']}, {x['n']}) e.g. {x['ex'][:2]}" for x in v) + (f' | no focus ring: {nr[:4]}' if nr else ''))
print('(routes not listed: no violations)')
