"""Compare the built HTML of two checkouts page by page after removing the known, intended edits.
usage: htmldiff.py <A/web/dist> <B/web/dist>
Known edits stripped from B: the Consent Mode default script, the footer Contact link, autocomplete="email",
and content-hashed asset names. Anything else that differs is printed (first lines) so a pixel difference on a
page can be traced to its source."""
import sys, os, re, difflib
A, B = sys.argv[1], sys.argv[2]
def norm(t):
    t = re.sub(r'/_astro/[^"\' )]+', '/_astro/X', t)
    t = re.sub(r'<script>\{?const CONSENT_REGIONS.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<script[^>]*>[^<]*gtag\(.consent.[^<]*</script>', '', t, flags=re.S)
    t = t.replace('<a href="/contact/">Contact</a>', '').replace(' autocomplete="email"', '')
    t = re.sub(r'<meta property="og:[^>]*>|<meta name="twitter:[^>]*>', lambda m: m.group(0), t)
    return t
files = []
for root, _, fs in os.walk(A):
    for f in fs:
        if f.endswith('.html'):
            files.append(os.path.relpath(os.path.join(root, f), A))
changed, shown = [], 0
for rel in sorted(files):
    pa, pb = os.path.join(A, rel), os.path.join(B, rel)
    if not os.path.exists(pb):
        changed.append((rel, 'missing in B')); continue
    ta, tb = norm(open(pa, encoding='utf8').read()), norm(open(pb, encoding='utf8').read())
    if ta == tb:
        continue
    changed.append((rel, 'differs'))
    if shown < 12:
        shown += 1
        la, lb = re.sub(r'>\s*<', '>\n<', ta).split('\n'), re.sub(r'>\s*<', '>\n<', tb).split('\n')
        d = [l for l in difflib.unified_diff(la, lb, lineterm='', n=0) if l[:1] in '+-' and l[:3] not in ('+++', '---')]
        print(f'HTML differs: {rel} ({len(d)} changed lines)')
        for l in d[:10]:
            print('   ', l[:260])
extra = [os.path.relpath(os.path.join(r, f), B) for r, _, fs in os.walk(B) for f in fs if f.endswith('.html') and not os.path.exists(os.path.join(A, os.path.relpath(os.path.join(r, f), B)))]
print(f'{len(files)} pages in A; {len([c for c in changed if c[1] == "differs"])} differ beyond the known edits; new pages only in B: {extra}')
