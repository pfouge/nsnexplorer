"""Screenshot + layout-box + behaviour harness for nsnexplorer.com builds.

usage: shoot.py <base_url> <out_dir> [shots,boxes,behave,forced]

  shots   every route in the routes file full-page at 390/1100/1366/1440, reduced motion, plus interactive
          states; records scrollWidth vs viewport and console errors.
  boxes   motion ON; position+size of every element at 390/768/1440 -> boxes.json
  behave  menus, dialogs, theme, search, forms, listeners registered, analytics page views -> behave.json
  forced  Windows High Contrast emulation (forced-colors), focus and selected states -> forced/*.png

env VR_ROUTES_FILE  route list (default routes.base.txt next to this file)
    VR_WIDTH        only this shots width (the runner shoots the four widths in parallel)
All requests that leave the machine are aborted in shots/boxes (Google tags, fonts, images); the site is
served by a local wrangler instance from a frozen database snapshot, so both builds see identical data.
Animations are held at their first frame in shots/boxes so a pulsing dot cannot add noise; the reduced-motion
fix for that dot is checked separately in 'behave' with computed styles.
"""
import sys, os, json, re
from playwright.sync_api import sync_playwright

BASE, OUT = sys.argv[1].rstrip('/'), sys.argv[2]
PASSES = (sys.argv[3] if len(sys.argv) > 3 else 'shots,boxes,behave,forced').split(',')
HERE = os.path.dirname(os.path.abspath(__file__))
ROUTES = [l.strip() for l in open(os.environ.get('VR_ROUTES_FILE') or os.path.join(HERE, 'routes.base.txt')) if l.strip()]
WIDTHS = [(390, 844), (1100, 800), (1366, 657), (1440, 900)]
if os.environ.get('VR_WIDTH'):
    WIDTHS = [x for x in WIDTHS if x[0] == int(os.environ['VR_WIDTH'])]
BOX_WIDTHS = [(390, 844), (768, 1024), (1440, 900)]
os.makedirs(OUT, exist_ok=True)
FIRST = lambda prefix, default=None: next((r for r in ROUTES if r.startswith(prefix)), default)
BIGFSC = '/fsc/5330/' if '/fsc/5330/' in ROUTES else FIRST('/fsc/', '/')
NSNPAGE = FIRST('/nsn/', '/')
GUIDE = '/guides/what-is-an-nsn/'

LOCAL = re.compile(r'^https?://(127\.0\.0\.1|localhost)[:/]')
FREEZE_INIT = """(() => { const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important}canvas{visibility:hidden!important}#viz-tip{display:none!important}';
  const put = () => (document.head || document.documentElement).appendChild(s);
  if (document.head || document.documentElement) put(); else document.addEventListener('DOMContentLoaded', put); })();"""
COUNT_INIT = """(() => { const c = {}; const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, ...r) {
    const who = this === document ? 'document' : this === window ? 'window' : null;
    if (who) c[who + ':' + t] = (c[who + ':' + t] || 0) + 1;
    return add.call(this, t, ...r); };
  window.__listeners = c; })();"""


def slug(r):
    s = re.sub(r'[^a-zA-Z0-9]+', '_', r).strip('_')
    return s or 'home'


def new_ctx(b, w, h, reduced=True, external=False, consent=False, forced=False, freeze=True, count=False):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, bypass_csp=not external,
                        reduced_motion='reduce' if reduced else 'no-preference',
                        forced_colors='active' if forced else 'none')
    if not external:
        ctx.route(re.compile(r'^https?://(?!127\.0\.0\.1|localhost)'), lambda route: route.abort())
    if consent is not None:
        ctx.route('**/api/region.json', lambda route: route.fulfill(json={'consent': consent}))
    if freeze:
        ctx.add_init_script(FREEZE_INIT)
        ctx.clock.set_fixed_time('2026-11-15T12:00:00Z')  # freshness bars and "N days left" read the clock
    if count:
        ctx.add_init_script(COUNT_INIT)
    return ctx


SETTLE = '''async () => {
  await document.fonts.ready;
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y < h; y += 300) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); }
  window.scrollTo(0, 0);
  const imgs = [...document.images];
  await Promise.race([
    Promise.all(imgs.map(i => i.complete ? 0 : new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); }))),
    new Promise(r => setTimeout(r, 8000))]);
  await new Promise(r => setTimeout(r, 500));
}'''


def open_page(ctx, route, errs=None, wait='load'):
    page = ctx.new_page()
    if errs is not None:
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    page.goto(BASE + route, wait_until=wait)
    page.evaluate(SETTLE)
    if route.startswith('/embed/'):
        page.wait_for_timeout(1200)
    return page


def clean(errs):
    # Failed external fetches are aborted on purpose; 404 for the missing page itself is the 404 route.
    return [e for e in errs if 'net::' not in e and 'ERR_' not in e and 'Failed to load resource' not in e]


FOOTNAV = "(() => { const n = document.querySelector('footer.site nav'); if (!n) return null; const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()"


def shot_state(ctx, w, name, route, act):
    page = open_page(ctx, route)
    try:
        act(page)
        page.wait_for_timeout(500)
        report[f'{name}_{w}'] = {'fn': page.evaluate(FOOTNAV), 'sw': 0, 'iw': 0, 'errors': []}  # viewport coordinates
        page.screenshot(path=f'{OUT}/{name}_{w}.png')
    except Exception as e:  # a control that is not shown at this width: record nothing, same in both builds
        print('state skipped', name, w, str(e).splitlines()[0][:100])
    page.close()


def click_if_visible(sel):
    def f(page):
        el = page.locator(sel).first
        if not el.is_visible():
            raise RuntimeError('not visible ' + sel)
        el.click()
    return f


report = {}
with sync_playwright() as p:
    b = p.chromium.launch()

    if 'shots' in PASSES:
        for (w, h) in WIDTHS:
            ctx = new_ctx(b, w, h)
            for r in ROUTES:
                errs = []
                page = open_page(ctx, r, errs)
                m = page.evaluate('() => ({sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight})')
                m['errors'] = clean(errs)
                m['fn'] = page.evaluate("(() => { const n = document.querySelector('footer.site nav'); if (!n) return null; const r = n.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; })()")
                if r.startswith('/embed/'):
                    # chart redraws can land between frames: keep the first frame that equals its successor
                    prev = page.screenshot(full_page=True)
                    for _ in range(6):
                        page.wait_for_timeout(400)
                        cur = page.screenshot(full_page=True)
                        if cur == prev:
                            break
                        prev = cur
                    open(f'{OUT}/{slug(r)}_{w}.png', 'wb').write(cur)
                else:
                    page.screenshot(path=f'{OUT}/{slug(r)}_{w}.png', full_page=True)
                report[f'{slug(r)}_{w}'] = m
                page.close()
            states = [
                ('state_drawer_open', '/', click_if_visible('.menu-btn')),
                ('state_search_dialog', '/', click_if_visible('.search-pill')),
                ('state_search_typed', '/', lambda pg: (click_if_visible('.search-pill')(pg), pg.keyboard.type('washer'), pg.wait_for_timeout(1500))),
                ('state_more_menu', '/', click_if_visible('nav.site details summary')),
                ('state_dark_theme', BIGFSC, lambda pg: pg.evaluate("document.documentElement.dataset.theme='dark'")),
                ('state_dark_home', '/', lambda pg: pg.evaluate("document.documentElement.dataset.theme='dark'")),
                ('state_accordion_open', NSNPAGE, lambda pg: pg.evaluate("document.querySelector('main details')?.setAttribute('open','')")),
                ('state_show_all', BIGFSC, lambda pg: pg.evaluate("document.querySelector('.show-all button')?.click()")),
                ('state_scrolled', BIGFSC, lambda pg: pg.evaluate('window.scrollTo(0, 900)')),
                ('state_footer', GUIDE, lambda pg: pg.evaluate('window.scrollTo(0, document.body.scrollHeight)')),
            ]
            for name, route, act in states:
                shot_state(ctx, w, name, route, act)
            ctx.close()
            # consent bar visible (a visitor in a region that is asked)
            ctx = new_ctx(b, w, h, consent=True)
            shot_state(ctx, w, 'state_consent_bar', '/', lambda pg: pg.wait_for_selector('#consent-bar', timeout=5000))
            ctx.close()
        json.dump(report, open(f"{OUT}/report{os.environ.get('VR_WIDTH', '')}.json", 'w'), indent=1)

    if 'forced' in PASSES:
        os.makedirs(f'{OUT}/forced', exist_ok=True)
        ctx = new_ctx(b, 1100, 800, forced=True)
        for name, route, act in [
            ('home_search_focus', '/', lambda pg: pg.focus('.search-box input')),
            ('signup_email_focus', '/suppliers/', lambda pg: (pg.locator('.signup-form input[type=email]').first.scroll_into_view_if_needed(), pg.focus('.signup-form input[type=email]'))),
            ('site_search_dialog', '/', lambda pg: click_if_visible('.search-pill')(pg)),
            ('class_chips', BIGFSC, lambda pg: pg.evaluate("window.scrollTo(0,0)")),
            ('open_chips', '/open/', lambda pg: pg.evaluate("window.scrollTo(0,0)")),
            ('part_page', NSNPAGE, lambda pg: pg.evaluate("window.scrollTo(0, 700)")),
            ('theme_switch_drawer', '/', lambda pg: pg.evaluate("document.getElementById('site-drawer').showModal()")),
        ]:
            page = open_page(ctx, route)
            try:
                act(page); page.wait_for_timeout(400)
                page.screenshot(path=f'{OUT}/forced/{name}_1100.png')
            except Exception as e:
                print('forced skipped', name, str(e).splitlines()[0][:100])
            page.close()
        ctx.close()

    if 'boxes' in PASSES:
        boxes = {}
        for (w, h) in BOX_WIDTHS:
            ctx = new_ctx(b, w, h, reduced=False)
            for r in ROUTES:
                page = open_page(ctx, r)
                page.wait_for_timeout(800)
                boxes[f'{slug(r)}_{w}'] = page.evaluate('''() => [...document.querySelectorAll('body *')]
                  .filter(e => !['SCRIPT','STYLE'].includes(e.tagName) && !e.closest('canvas') && e.id !== 'viz-tip')
                  .map(e => { const r = e.getBoundingClientRect();
                    return (e.closest('footer.site') ? 'FOOT:' : '') + e.tagName + '.' + (typeof e.className === 'string' ? e.className : '') +
                      '|' + [r.x, r.y + scrollY, r.width, r.height].map(v => Math.round(v * 10) / 10).join(','); })''')
                page.close()
            ctx.close()
        json.dump(boxes, open(f'{OUT}/boxes.json', 'w'))

    if 'behave' in PASSES:
        beh = {}

        def guard(name, fn):
            try:
                beh[name] = fn()
            except Exception as e:
                beh[name] = {'ERROR': str(e).splitlines()[0][:200]}

        dlg = "(id) => { const d = document.getElementById(id); return d ? d.open : null; }"

        def menus():
            ctx = new_ctx(b, 1440, 900, count=True)
            page = open_page(ctx, '/')
            r = {}
            page.click('.search-pill'); page.wait_for_timeout(300); r['search_open'] = page.evaluate(dlg, 'site-search')
            r['search_input_focused'] = page.evaluate("document.activeElement?.hasAttribute('data-site-search-input')")
            page.keyboard.press('Escape'); page.wait_for_timeout(300); r['search_after_escape'] = page.evaluate(dlg, 'site-search')
            page.keyboard.press('/'); page.wait_for_timeout(300); r['search_open_by_slash'] = page.evaluate(dlg, 'site-search')
            page.keyboard.press('Escape'); page.wait_for_timeout(200)
            page.click('nav.site details summary'); page.wait_for_timeout(200); r['more_open'] = page.evaluate("document.querySelector('nav.site details').open")
            page.mouse.click(700, 600); page.wait_for_timeout(200); r['more_after_outside_click'] = page.evaluate("document.querySelector('nav.site details').open")
            page.click('nav.site details summary'); page.keyboard.press('Escape'); page.wait_for_timeout(200); r['more_after_escape'] = page.evaluate("document.querySelector('nav.site details').open")
            # theme: one click flips once, survives a reload, second click flips back
            page.click('.theme-toggle'); r['theme_after_click'] = page.evaluate("[document.documentElement.dataset.theme || 'light', localStorage.getItem('theme')]")
            page.reload(wait_until='load'); r['theme_after_reload'] = page.evaluate("document.documentElement.dataset.theme || 'light'")
            page.click('.theme-toggle'); r['theme_after_second_click'] = page.evaluate("[document.documentElement.dataset.theme || 'light', localStorage.getItem('theme')]")
            r['listeners_registered'] = page.evaluate('window.__listeners')
            ctx.close()
            ctx = new_ctx(b, 390, 844)
            page = open_page(ctx, '/')
            page.click('.menu-btn'); page.wait_for_timeout(300); r['drawer_open'] = page.evaluate(dlg, 'site-drawer')
            page.keyboard.press('Escape'); page.wait_for_timeout(300); r['drawer_after_escape'] = page.evaluate(dlg, 'site-drawer')
            page.click('.menu-btn'); page.wait_for_timeout(300)
            page.mouse.click(385, 400); page.wait_for_timeout(300); r['drawer_after_backdrop_click'] = page.evaluate(dlg, 'site-drawer')
            page.click('.menu-btn'); page.click('#site-drawer [data-close]'); page.wait_for_timeout(300); r['drawer_after_close_button'] = page.evaluate(dlg, 'site-drawer')
            ctx.close()
            return r
        guard('menus', menus)

        def search():
            ctx = new_ctx(b, 1440, 900)
            page = open_page(ctx, '/')
            page.click('.search-pill'); page.keyboard.type('washer'); page.wait_for_timeout(2000)
            r = {'sections': page.evaluate("[...document.querySelectorAll('#site-search h2')].map(h => h.textContent)"),
                 'results': page.evaluate("document.querySelectorAll('#site-search a.result').length")}
            page.keyboard.press('Enter'); page.wait_for_timeout(2500)
            r['enter_goes_to'] = re.sub(r'^https?://[^/]+', '', page.url)
            page.close()
            page = open_page(ctx, '/search/')
            page.fill('#name-q', 'washer'); page.keyboard.press('Enter'); page.wait_for_timeout(2500)
            r['search_page_submit'] = re.sub(r'^https?://[^/]+', '', page.url)
            r['search_page_results'] = page.evaluate("document.querySelectorAll('main a[href^=\"/nsn/\"]').length")
            page.close()
            ctx.close()
            return r
        guard('search', search)

        def components():
            ctx = new_ctx(b, 390, 844, count=True)
            page = open_page(ctx, BIGFSC)
            r = {'product_cards': page.evaluate("document.querySelectorAll('.product-card').length"),
                 'show_all_buttons': page.evaluate("document.querySelectorAll('.show-all button').length"),
                 'clamp_more_buttons': page.evaluate("document.querySelectorAll('button.clamp-more').length")}
            if r['show_all_buttons']:
                page.click('.show-all button'); r['grid_expanded_after_click'] = page.evaluate("document.querySelector('.product-grid').classList.contains('expanded')")
                r['show_all_after_click'] = page.evaluate("document.querySelectorAll('.show-all button').length")
            if r['clamp_more_buttons']:
                page.click('button.clamp-more'); r['clamp_after_click'] = page.evaluate("document.querySelectorAll('button.clamp-more').length")
            r['tabs'] = page.evaluate("document.querySelectorAll('nav.tabs').length")
            if r['tabs']:
                cur = []
                for y in (0, 1200, 2600, 0):
                    page.evaluate(f'window.scrollTo(0,{y})'); page.wait_for_timeout(500)
                    cur.append(page.evaluate("[...document.querySelectorAll('nav.tabs a[aria-current]')].map(a => a.hash)"))
                r['tab_current_by_scroll'] = cur
            r['listeners_registered'] = page.evaluate('window.__listeners')
            page.close()
            page = open_page(ctx, NSNPAGE)
            tabs = page.evaluate("[...document.querySelectorAll('nav.tabs a[href^=\"#\"]')].map(a => a.hash)")
            r['part_tabs'] = tabs
            cur = {}
            for h in tabs[:6]:
                page.evaluate(f"document.querySelector('nav.tabs a[href=\"{h}\"]').click()"); page.wait_for_timeout(900)
                cur[h] = page.evaluate("[...document.querySelectorAll('nav.tabs a[aria-current]')].map(a => a.hash)")
            r['part_tab_current_after_click'] = cur
            ctx.close()
            return r
        guard('components', components)

        def headers():
            ctx = new_ctx(b, 1100, 800)
            r = {}
            for route in ('/', NSNPAGE, '/embed/fsc/5330/demand/' if '/embed/fsc/5330/demand/' in ROUTES else FIRST('/embed/', '/')):
                resp = ctx.request.get(BASE + route)
                h = resp.headers
                r[route] = {'status': resp.status, 'csp': h.get('content-security-policy'), 'xfo': h.get('x-frame-options')}
            ctx.close()
            return r
        guard('headers', headers)

        def forms():
            ctx = new_ctx(b, 1100, 800)
            r = {}
            page = open_page(ctx, '/suppliers/')
            r['signup_form_present'] = page.evaluate("!!document.querySelector('.signup-form')")
            r['signup_email_autocomplete'] = page.evaluate("document.querySelector('.signup-form input[type=email]')?.getAttribute('autocomplete')")
            if r['signup_form_present']:
                page.fill('.signup-form input[type=email]', 'harness-' + BASE.split(':')[-1] + '@example.invalid')
                with page.expect_response(lambda x: x.url.endswith('/api/signup'), timeout=15000) as ri:
                    page.click('.signup-form button[type=submit]')
                r['signup_status'] = ri.value.status; r['signup_body'] = ri.value.text()[:160]
            for label, payload in (('bad_email', {'email': 'nope', 'hook': 'shop_alerts'}), ('valid_json', {'email': 'harness-json-' + BASE.split(':')[-1] + '@example.invalid', 'hook': 'shop_alerts'})):
                resp = page.request.post(BASE + '/api/signup', data=payload, headers={'content-type': 'application/json', 'accept': 'application/json'})
                r['signup_api_' + label] = [resp.status, resp.text()[:120]]
            page.close()
            page = open_page(ctx, '/compare/')
            page.fill('input[name=nsn1]', (NSNPAGE or '').split('/')[-2] if NSNPAGE.startswith('/nsn/') else '')
            page.keyboard.press('Enter'); page.wait_for_timeout(2500)
            r['compare_hash'] = page.evaluate('location.hash')
            r['compare_svg'] = page.evaluate("document.querySelectorAll('svg.viz-svg, .viz-body svg').length > 0")
            page.close()
            page = open_page(ctx, '/lookup/')
            nsn = (NSNPAGE or '').split('/')[-2] if NSNPAGE.startswith('/nsn/') else ''
            ta = page.locator('textarea').first
            ta.fill(nsn)
            page.click('#bulk-form button[type=submit], #bulk-form button')
            page.wait_for_timeout(3000)
            r['lookup_rows'] = page.evaluate("document.querySelectorAll('table tbody tr').length")
            page.close()
            ctx.close()
            return r
        guard('forms', forms)

        def motion():
            # reduced motion, no freezing: the pulse dot and the switch must not animate
            ctx = new_ctx(b, 1100, 800, freeze=False)
            page = open_page(ctx, '/')
            r = page.evaluate("""() => ({
              switchTransition: getComputedStyle(document.querySelector('.switch')).transitionDuration,
              switchKnobTransition: getComputedStyle(document.querySelector('.switch'), '::after').transitionDuration })""")
            page.close(); ctx.close()
            ctx = new_ctx(b, 1100, 800, reduced=False, freeze=False)
            page = open_page(ctx, '/')
            r['motion_on_switchTransition'] = page.evaluate("getComputedStyle(document.querySelector('.switch')).transitionDuration")
            page.close(); ctx.close()
            return r
        guard('reduced_motion', motion)

        # analytics: the real Google tag is allowed here; count page_view hits per page and scenario
        def analytics():
            pages = ['/', '/about/', GUIDE, BIGFSC, NSNPAGE]
            res = {}
            for scenario in ('free_region', 'asked_then_allowed', 'asked_then_declined', 'global_privacy_control'):
                ga = {}
                consent = scenario != 'free_region'
                ctx = new_ctx(b, 1366, 800, external=True, consent=consent, freeze=False)
                if scenario == 'global_privacy_control':
                    ctx.add_init_script("Object.defineProperty(navigator, 'globalPrivacyControl', {value: true});")
                for r in pages:
                    hits, tags, errs = [], [], []
                    page = ctx.new_page()

                    def on_req(rq, hits=hits, tags=tags):
                        u = rq.url
                        if '/g/collect' in u:
                            body = rq.post_data or ''
                            ens = re.findall(r'(?:^|[&?\n])en=([a-z_]+)', u + '\n' + body)
                            gcs = re.findall(r'[&?]gcs=([^&]+)', u)
                            hits.append({'en': ens, 'gcs': gcs})
                        if 'adsbygoogle.js' in u or 'gtag/js' in u:
                            tags.append(u.split('?')[0].split('/')[-1])
                    page.on('request', on_req)
                    page.on('console', lambda m, errs=errs: errs.append(m.text) if m.type == 'error' else None)
                    page.goto(BASE + r, wait_until='load')
                    page.wait_for_timeout(2500)
                    clicked = None
                    if scenario == 'asked_then_allowed':
                        page.evaluate("localStorage.clear()")
                        page.reload(wait_until='load'); page.wait_for_timeout(1500)
                        before = len(hits)
                        if page.locator('#consent-bar').count():
                            page.click('#consent-bar button:has-text("Allow")'); clicked = 'allow'
                        page.wait_for_timeout(6000)
                    elif scenario == 'asked_then_declined':
                        page.evaluate("localStorage.clear()")
                        page.reload(wait_until='load'); page.wait_for_timeout(1500)
                        if page.locator('#consent-bar').count():
                            page.click('#consent-bar button:has-text("No thanks")'); clicked = 'decline'
                        page.wait_for_timeout(6000)
                    else:
                        page.wait_for_timeout(6000)
                    ga[r] = {'page_views': sum(h['en'].count('page_view') for h in hits), 'hits': hits, 'clicked': clicked,
                             'tags_loaded': sorted(set(tags)),
                             'consent_commands': page.evaluate("(window.dataLayer||[]).filter(a => a && a[0]==='consent').map(a => [a[1], a[2] && a[2].analytics_storage, a[2] && a[2].ad_storage, (a[2] && a[2].region || []).length, a[2] && a[2].wait_for_update])"),
                             'config_calls': page.evaluate("(window.dataLayer||[]).filter(a => a && a[0]==='config').length"),
                             'csp_errors': sorted(set(e[:160] for e in errs if 'Content Security Policy' in e))}
                    page.close()
                ctx.close()
                res[scenario] = ga
            return res
        guard('analytics', analytics)
        json.dump(beh, open(f'{OUT}/behave.json', 'w'), indent=1)

    b.close()

if 'shots' in PASSES:
    bad = {k: v for k, v in report.items() if v['sw'] != v['iw'] or v['errors']}
    print('shots:', len(report), 'overflow/errors:', json.dumps(bad, indent=1) if bad else 'none')
