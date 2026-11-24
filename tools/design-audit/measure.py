"""Page-type measurements for the redesign (design/page-type-audit.md).

usage: measure.py <base_url> <routes_file> <out_dir> [--no-shots]

For every route, at 390x844, 768x1024 and 1280x800:
  height in screens, sideways scroll, cumulative layout shift, what is on the first screen,
  how far down the first answer sits (in screens), rows in every table (all and visible),
  DOMContentLoaded and load times, and a full-page JPEG (capped at 24,000 px).
Then a sweep of every width from 320 to 1440 in 10 px steps for sideways scroll.
Writes <out_dir>/measure.json and <out_dir>/shots/<slug>-<width>.jpg.
Requests that leave the machine are aborted so both builds load the same things.
"""
import sys, os, json, re
from playwright.sync_api import sync_playwright

BASE, ROUTES_FILE, OUT = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
SHOTS = '--no-shots' not in sys.argv
AXE = sys.argv[sys.argv.index('--axe') + 1] if '--axe' in sys.argv else None  # path to axe.min.js
ROUTES = [l.strip() for l in open(ROUTES_FILE) if l.strip() and not l.startswith('#')]
SIZES = [(390, 844), (768, 1024), (1280, 800)]
SWEEP = list(range(320, 1441, 10)) if not os.environ.get("DA_SWEEP_STEP") else list(range(320, 1441, int(os.environ["DA_SWEEP_STEP"])))
os.makedirs(f'{OUT}/shots', exist_ok=True)

CLS_INIT = """(() => { window.__cls = 0; window.__shifts = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
      window.__cls += e.value;
      window.__shifts.push({v: +e.value.toFixed(4), t: Math.round(e.startTime),
        src: (e.sources || []).slice(0, 3).map(s => s.node ? (s.node.id ? '#' + s.node.id : (s.node.className && s.node.className.baseVal === undefined ? '.' + String(s.node.className).split(' ')[0] : s.node.nodeName)) : '?')}); }
  }).observe({type: 'layout-shift', buffered: true}); } catch (e) {} })();"""

SETTLE = """async () => {
  await document.fonts.ready;
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y < Math.min(h, 60000); y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 15)); }
  window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 400));
}"""

# Elements that count as "an answer": the first datum a visitor came for.
PROBE = r"""() => {
  const ih = innerHeight, iw = innerWidth, de = document.documentElement;
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const top = el => el.getBoundingClientRect().top + scrollY;
  const ANSWER = ['[data-answer]', 'table tbody tr', 'dl dd', '.datastrip', '.stat-strip', '.kv', '.product-card', '.viz svg', 'svg.viz'];
  let first = null, firstSel = null;
  for (const sel of ANSWER) for (const el of document.querySelectorAll(sel)) {
    if (el.closest('header, footer, nav, dialog')) continue;
    if (!vis(el)) continue; const t = top(el);
    if (first === null || t < first) { first = t; firstSel = sel; } break; }
  const tables = [...document.querySelectorAll('table')].map(t => {
    const rows = [...t.querySelectorAll('tbody tr')];
    return { id: t.id || t.closest('[id]')?.id || '', caption: (t.caption?.textContent || t.getAttribute('aria-label') || '').trim().slice(0, 80),
             rows: rows.length, visible: rows.filter(vis).length, cols: t.querySelectorAll('thead th').length }; });
  const fs = [];
  for (const el of document.querySelectorAll('main h1, main h2, main h3, h1, [data-answer], table, dl, .viz, svg')) {
    if (!vis(el) || el.closest('header, footer, nav, dialog')) continue;
    const r = el.getBoundingClientRect(); if (r.top + scrollY >= ih) continue;
    const name = el.tagName.toLowerCase();
    fs.push(name + (/^h\d$/.test(name) ? ': ' + el.textContent.trim().replace(/\s+/g, ' ').slice(0, 70) : ''));
  }
  const header = document.querySelector('header'); const h1 = document.querySelector('h1');
  return { height: de.scrollHeight, iw, ih, sw: de.scrollWidth,
           screens: +(de.scrollHeight / ih).toFixed(1),
           firstAnswerScreens: first === null ? null : +(first / ih).toFixed(2), firstAnswerSel: firstSel,
           h1Top: h1 ? Math.round(h1.getBoundingClientRect().top + scrollY) : null,
           headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
           firstScreen: [...new Set(fs)].slice(0, 25), tables,
           longestTable: tables.reduce((m, t) => Math.max(m, t.rows), 0),
           totalRows: tables.reduce((m, t) => m + t.rows, 0),
           sections: document.querySelectorAll('main section, main details').length,
           details: document.querySelectorAll('details').length,
           domNodes: document.getElementsByTagName('*').length,
           htmlBytes: de.outerHTML.length,
           cls: +(window.__cls || 0).toFixed(4), shifts: (window.__shifts || []).slice(0, 8) };
}"""


def slug(r):
    return re.sub(r'[^a-zA-Z0-9]+', '_', r).strip('_') or 'home'


def main():
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        for w, h in SIZES:
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, reduced_motion='reduce')
            ctx.route(re.compile(r'^https?://(?!127\.0\.0\.1|localhost)'), lambda route: route.abort())
            ctx.route('**/api/region.json', lambda route: route.fulfill(json={'consent': False}))
            ctx.add_init_script(CLS_INIT)
            for r in ROUTES:
                page = ctx.new_page(); errs = []
                page.on('pageerror', lambda e, errs=errs: errs.append(str(e)[:200]))
                try:
                    resp = page.goto(BASE + r, wait_until='load', timeout=90000)
                    page.evaluate(SETTLE)
                    m = page.evaluate(PROBE)
                    m['status'] = resp.status if resp else None
                    t = page.evaluate("(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? {dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd)} : {}; })()")
                    m.update(t); m['errors'] = errs
                    if SHOTS:
                        hh = min(m['height'], 24000)
                        page.screenshot(path=f'{OUT}/shots/{slug(r)}-{w}.jpg', type='jpeg', quality=55,
                                        clip={'x': 0, 'y': 0, 'width': w, 'height': hh}, full_page=True)
                except Exception as e:
                    m = {'error': str(e)[:300]}
                res.setdefault(r, {})[str(w)] = m
                page.close()
                print(w, r, m.get('screens'), 'error' if 'error' in m else '', flush=True)
            ctx.close()
        # Accessibility: axe-core (WCAG 2 A and AA rules) and a keyboard pass (Tab through the first 25
        # stops; every focused element must show a focus ring).
        if AXE:
            ctx = b.new_context(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce')
            ctx.route(re.compile(r'^https?://(?!127\.0\.0\.1|localhost)'), lambda route: route.abort())
            ctx.route('**/api/region.json', lambda route: route.fulfill(json={'consent': False}))
            for r in ROUTES:
                page = ctx.new_page()
                try:
                    page.goto(BASE + r, wait_until='load', timeout=90000)
                    page.add_script_tag(path=AXE)
                    v = page.evaluate("async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })).violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }))")
                    keys = []
                    for _ in range(25):
                        page.keyboard.press('Tab')
                        keys.append(page.evaluate('''() => { const e = document.activeElement; if (!e || e === document.body) return null;
                          const s = getComputedStyle(e); const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
                          return { el: e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''), text: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30), ring }; }'''))
                    res.setdefault(r, {})['a11y'] = {'axe': v, 'no_ring': [k for k in keys if k and not k['ring']]}
                except Exception as e:
                    res.setdefault(r, {})['a11y'] = {'error': str(e)[:200]}
                page.close()
                print('a11y', r, len(res[r]['a11y'].get('axe', [])), 'violations', flush=True)
            ctx.close()
        # Sideways-scroll sweep: resize the same page through every width.
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        ctx.route(re.compile(r'^https?://(?!127\.0\.0\.1|localhost)'), lambda route: route.abort())
        for r in ROUTES:
            page = ctx.new_page(); over = []
            try:
                page.goto(BASE + r, wait_until='load', timeout=90000)
                for w in SWEEP:
                    page.set_viewport_size({'width': w, 'height': 900})
                    sw = page.evaluate('document.documentElement.scrollWidth')
                    if sw > w: over.append([w, sw - w])
            except Exception as e:
                over = [['error', str(e)[:200]]]
            res.setdefault(r, {})['sweep_overflow'] = over
            page.close()
            print('sweep', r, len(over), 'widths overflow', flush=True)
        b.close()
    json.dump(res, open(f'{OUT}/measure.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
