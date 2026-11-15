"""Compare element layout boxes of two runs. usage: boxdiff.py <a>/boxes.json <b>/boxes.json"""
import sys, json
from collections import Counter
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
bad = 0
for k in sorted(a):
    ca, cb = Counter(a[k]), Counter(b.get(k, []))
    if ca == cb:
        continue
    bad += 1
    only_a, only_b = list((ca - cb).elements()), list((cb - ca).elements())
    print(f'{k}: {len(only_a)} boxes only in A, {len(only_b)} only in B')
    for x in only_a[:4]: print('   A', x[:150])
    for x in only_b[:4]: print('   B', x[:150])
print(f'{len(a)} pages compared, {len(a) - bad} with identical layout boxes, {bad} differing; elements in A: {sum(len(v) for v in a.values())}')
