"""Compare element layout boxes of two runs. usage: boxdiff.py <a>/boxes.json <b>/boxes.json
Elements inside the footer are tagged FOOT: by the harness; they are counted separately so the new footer
link (a known change) is visible but does not hide differences elsewhere."""
import sys, json
from collections import Counter
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
bad_body, bad_foot = 0, 0
foot_sig = Counter()
for k in sorted(a):
    for part, tag in (('body', lambda x: not x.startswith('FOOT:')), ('foot', lambda x: x.startswith('FOOT:'))):
        ca, cb = Counter(x for x in a[k] if tag(x)), Counter(x for x in b.get(k, []) if tag(x))
        if ca == cb:
            continue
        only_a, only_b = list((ca - cb).elements()), list((cb - ca).elements())
        if part == 'foot':
            bad_foot += 1; foot_sig[(len(only_a), len(only_b))] += 1
            continue
        bad_body += 1
        print(f'{k}: {len(only_a)} boxes only in A, {len(only_b)} only in B (outside the footer)')
        for x in only_a[:4]: print('   A', x[:150])
        for x in only_b[:4]: print('   B', x[:150])
print(f'{len(a)} pages compared; {len(a) - bad_body} with identical layout boxes outside the footer, {bad_body} differing; elements in A: {sum(len(v) for v in a.values())}')
print(f'footer boxes differ on {bad_foot} pages; (only-in-A, only-in-B) box counts by page: {dict(foot_sig)}')
