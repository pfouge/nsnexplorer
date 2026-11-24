"""Before-and-after checker: proves nothing a visitor or a search engine could see was lost.

usage: compare.py <base_url_A> <base_url_B> <routes_file> <out_json> [--allow <allow.json>]

For every route it fetches the served HTML from both builds and compares:
  FAIL  status code, <title>, meta description, canonical, robots, og:title/description,
        heading text (h1-h6, as a multiset: order may change, text may not),
        JSON-LD (parsed, key order ignored), table rows (total and per table),
        element ids (deep-link targets), number tokens in the body text,
        internal links present in A but not in B
  WARN  word tokens of body text present in A but missing in B, headings added in B
Hidden rows must stay in the HTML, so served HTML is the right thing to compare.
--allow takes {"route": {"words": [...], "ids": [...], "links": [...], "headings_added": true}} for
reviewed, deliberate changes; everything allowed is still listed in the report.
Exit code 1 when any FAIL remains.
"""
import sys, json, re, collections, urllib.request
from html.parser import HTMLParser

A, B, ROUTES_FILE, OUT = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/'), sys.argv[3], sys.argv[4]
ALLOW = {}
if '--allow' in sys.argv:
    ALLOW = json.load(open(sys.argv[sys.argv.index('--allow') + 1]))
ROUTES = [l.strip() for l in open(ROUTES_FILE) if l.strip() and not l.startswith('#')]
SKIP_TEXT = {'script', 'style', 'noscript', 'template', 'svg'}
CHROME = {'header', 'footer', 'nav'}  # site chrome: compared separately, its text may be redesigned


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''; self.meta = {}; self.canonical = None; self.headings = []; self.jsonld = []
        self.ids = []; self.links = set(); self.text = []; self.chrome_text = []
        self.tables = []; self._stack = []; self._h = None; self._ld = None; self._title = False
        self._table = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag not in ('br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr', 'col', 'area', 'base', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'use', 'stop', 'ellipse'):
            self._stack.append(tag)
        if a.get('id'): self.ids.append(a['id'])
        if tag == 'title': self._title = True
        elif tag == 'meta':
            k = a.get('name') or a.get('property')
            if k in ('description', 'robots', 'og:title', 'og:description', 'og:url', 'twitter:title'):
                self.meta[k] = (a.get('content') or '').strip()
        elif tag == 'link' and a.get('rel') == 'canonical':
            self.canonical = a.get('href')
        elif re.fullmatch(r'h[1-6]', tag):
            self._h = [tag, '']
        elif tag == 'script' and a.get('type') == 'application/ld+json':
            self._ld = ''
        elif tag == 'a' and a.get('href', '').startswith('/'):
            self.links.add(a['href'].split('#')[0])
        elif tag == 'table':
            self._table.append({'id': a.get('id') or '', 'label': a.get('aria-label') or '', 'rows': 0})
        elif tag == 'tr' and self._table and 'tbody' in self._stack:
            self._table[-1]['rows'] += 1

    def handle_endtag(self, tag):
        if tag == 'title': self._title = False
        if self._h and tag == self._h[0]:
            self.headings.append(self._h[0] + ':' + re.sub(r'\s+', ' ', self._h[1]).strip()); self._h = None
        if tag == 'script' and self._ld is not None:
            try: self.jsonld.append(json.loads(self._ld))
            except Exception: self.jsonld.append({'_unparsed': self._ld[:200]})
            self._ld = None
        if tag == 'table' and self._table:
            self.tables.append(self._table.pop())
        if tag in self._stack:
            while self._stack and self._stack.pop() != tag: pass

    def handle_data(self, d):
        if self._title: self.title += d
        if self._h is not None: self._h[1] += d
        if self._ld is not None: self._ld += d; return
        if any(t in SKIP_TEXT for t in self._stack): return
        (self.chrome_text if any(t in CHROME for t in self._stack) else self.text).append(d)


def fetch(base, route):
    try:
        with urllib.request.urlopen(base + route, timeout=120) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return None, ''


def parse(html):
    p = Page(); p.feed(html); return p


def toks(texts):
    words = re.findall(r"[A-Za-z0-9$%.,/'-]+", ' '.join(texts))
    words = [w.strip('.,') for w in words if w.strip('.,')]
    nums = [w for w in words if re.search(r'\d', w)]
    return collections.Counter(w.lower() for w in words), collections.Counter(nums)


def norm(o):
    return json.dumps(o, sort_keys=True)


def main():
    report = {}; fails = 0
    for r in ROUTES:
        sa, ha = fetch(A, r); sb, hb = fetch(B, r)
        pa, pb = parse(ha), parse(hb); al = ALLOW.get(r, {})
        f, w, allowed = [], [], []
        if sa != sb: f.append(f'status {sa} -> {sb}')
        if pa.title.strip() != pb.title.strip(): f.append(f'title {pa.title.strip()!r} -> {pb.title.strip()!r}')
        for k in set(pa.meta) | set(pb.meta):
            if pa.meta.get(k) != pb.meta.get(k): f.append(f'meta {k} changed')
        if pa.canonical != pb.canonical: f.append(f'canonical {pa.canonical} -> {pb.canonical}')
        ca, cb = collections.Counter(pa.headings), collections.Counter(pb.headings)
        lost_h = list((ca - cb).elements()); added_h = list((cb - ca).elements())
        if lost_h: f.append(f'headings lost or changed: {lost_h[:10]}')
        if added_h: (allowed if al.get('headings_added') else w).append(f'headings added: {added_h[:10]}')
        ja, jb = sorted(map(norm, pa.jsonld)), sorted(map(norm, pb.jsonld))
        if ja != jb: f.append(f'JSON-LD differs ({len(ja)} vs {len(jb)} blocks)')
        ra, rb = sum(t['rows'] for t in pa.tables), sum(t['rows'] for t in pb.tables)
        if rb < ra: f.append(f'table rows {ra} -> {rb}')
        ta = collections.Counter((t['id'] or t['label'], t['rows']) for t in pa.tables if t['id'] or t['label'])
        tb = collections.Counter((t['id'] or t['label'], t['rows']) for t in pb.tables if t['id'] or t['label'])
        if ta - tb: f.append(f'named tables changed: {list((ta - tb).elements())[:6]}')
        lost_ids = [i for i in set(pa.ids) - set(pb.ids) if i not in al.get('ids', [])]
        if lost_ids: f.append(f'ids lost: {sorted(lost_ids)[:15]}')
        lost_links = [l for l in pa.links - pb.links if l not in al.get('links', [])]
        if lost_links: f.append(f'internal links lost: {sorted(lost_links)[:15]}')
        wa, na = toks(pa.text); wb, nb = toks(pb.text)
        # Text that moved into or out of the chrome still counts as present.
        cwb, cnb = toks(pb.chrome_text)
        lost_n = list(((na) - (nb + cnb)).elements())
        if lost_n: f.append(f'numbers lost: {lost_n[:20]}')
        lost_w = [x for x in (wa - (wb + cwb)).elements() if not re.search(r'\d', x) and x not in al.get('words', [])]
        if lost_w: w.append(f'words lost ({len(lost_w)}): {lost_w[:30]}')
        report[r] = {'status': [sa, sb], 'rows': [ra, rb], 'headings': [len(pa.headings), len(pb.headings)],
                     'fail': f, 'warn': w, 'allowed': allowed}
        fails += len(f)
        print(('FAIL ' if f else 'ok   ') + r, '|'.join(f)[:300], ('WARN ' + '|'.join(w)[:200]) if w else '', flush=True)
    json.dump(report, open(OUT, 'w'), indent=1)
    print(f'{len(ROUTES)} routes, {fails} failures')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
