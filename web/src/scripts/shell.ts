// scripts/shell.ts — the site shell's behaviour: the navigation drawer, the
// search dialog, in-page tabs, folded introductions and "show all" on long
// lists. Everything degrades to plain links and full content without it.

/* ---------- dialogs ---------- */
function openDialog(id: string): void {
  const d = document.getElementById(id);
  if (!(d instanceof HTMLDialogElement) || d.open) return;
  d.showModal();
  if (id === 'site-search') d.querySelector<HTMLInputElement>('[data-site-search-input]')?.focus();
}
document.querySelectorAll<HTMLElement>('[data-open]').forEach((b) =>
  b.addEventListener('click', () => openDialog(b.dataset.open ?? '')),
);
document.querySelectorAll<HTMLDialogElement>('dialog.sheet').forEach((d) => {
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  // A click on the backdrop (outside the panel) closes it.
  d.addEventListener('click', (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
});
// "/" opens search from anywhere outside a text field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  e.preventDefault();
  openDialog('site-search');
});
// The desktop "More" menu closes on an outside click or Escape.
const more = document.querySelector<HTMLDetailsElement>('nav.site details');
if (more) {
  document.addEventListener('click', (e) => {
    if (more.open && e.target instanceof Node && !more.contains(e.target)) more.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') more.open = false;
  });
}

/* ---------- search ---------- */
type ClassRow = [string, string, number, 0 | 1, 0 | 1];
interface SearchIndex {
  classes: ClassRow[];
  groups: [string, string][];
  agencies: [string, string][];
  services: [string, string, number][];
}
interface LookupResult {
  ok: boolean;
  kind: 'nsn' | 'niin' | 'part_number' | 'invalid';
  matches: string[];
  error?: string;
}
interface Hit {
  href: string;
  code?: string;
  name: string;
  meta?: string;
}

const form = document.querySelector<HTMLFormElement>('[data-site-search]');
const input = document.querySelector<HTMLInputElement>('[data-site-search-input]');
const out = document.querySelector<HTMLElement>('[data-site-search-results]');

if (form && input && out) {
  const idle = out.innerHTML; // the hint and jump chips, server-rendered
  let index: Promise<SearchIndex | null> | null = null;
  let seq = 0;
  let timer = 0;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const loadIndex = () =>
    (index ??= fetch('/data/search-index.json')
      .then((r) => (r.ok ? (r.json() as Promise<SearchIndex>) : null))
      .catch(() => null));

  const section = (title: string, hits: Hit[]): DocumentFragment => {
    const f = document.createDocumentFragment();
    if (!hits.length) return f;
    const h = document.createElement('h2');
    h.textContent = title;
    f.append(h);
    for (const hit of hits) {
      const a = document.createElement('a');
      a.className = 'result';
      a.href = hit.href;
      if (hit.code) {
        const c = document.createElement('span');
        c.className = 'code';
        c.textContent = hit.code;
        a.append(c);
      }
      const n = document.createElement('span');
      n.className = 'nm';
      n.textContent = hit.name;
      a.append(n);
      if (hit.meta) {
        const m = document.createElement('span');
        m.className = 'meta';
        m.textContent = hit.meta;
        a.append(m);
      }
      f.append(a);
    }
    return f;
  };
  const message = (text: string, error = false): HTMLParagraphElement => {
    const p = document.createElement('p');
    p.className = 'search-msg';
    if (error) p.dataset.state = 'error';
    p.textContent = text;
    return p;
  };

  // Instant matches from the small index: categories, groups, agencies, services.
  const localHits = (ix: SearchIndex, q: string): { title: string; hits: Hit[] }[] => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, '');
    const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const classes = ix.classes
      .filter(([code, name]) => (digits.length >= 2 && digits.length <= 4 && /^[\d\s]+$/.test(q) ? code.startsWith(digits) : has(`${name} ${code}`)))
      .sort((a, b) => b[2] - a[2])
      .slice(0, 8)
      .map<Hit>(([code, name, open, hasOpen, hasPriced]) => ({
        href: hasOpen ? `/open/${code}/` : hasPriced ? `/fsc/${code}/` : `/catalog/`,
        code: `FSC ${code}`,
        name,
        meta: open > 0 ? `${fmt(open)} open` : hasPriced ? 'price history' : undefined,
      }));
    const groups = ix.groups
      .filter(([code, name]) => (/^\d{2}$/.test(q.trim()) ? code === q.trim() : has(name)))
      .slice(0, 4)
      .map<Hit>(([code, name]) => ({ href: `/group/${code}/`, code: `FSG ${code}`, name }));
    const agencies = ix.agencies.filter(([, name]) => has(name)).slice(0, 4).map<Hit>(([slug, name]) => ({ href: `/agency/${slug}/`, name }));
    const services = ix.services
      .filter(([, name]) => has(name))
      .slice(0, 4)
      .map<Hit>(([key, name, n]) => ({ href: `/services/${key}/`, name, meta: `${fmt(n)} open` }));
    return [
      { title: 'Supply classes', hits: classes },
      { title: 'Supply groups', hits: groups },
      { title: 'Agencies', hits: agencies },
      { title: 'Service categories', hits: services },
    ];
  };

  // An NSN, NIIN or part number goes to the lookup endpoint.
  const looksLikeId = (q: string): boolean => {
    const digits = q.replace(/\D/g, '');
    if (/^[\d\s-]+$/.test(q)) return digits.length === 9 || digits.length === 13;
    return /\d/.test(q) && q.replace(/[^A-Za-z0-9]/g, '').length >= 4;
  };
  const lookup = async (q: string): Promise<LookupResult | null> => {
    try {
      const res = await fetch(`/api/lookup.json?q=${encodeURIComponent(q)}`);
      return (await res.json()) as LookupResult;
    } catch {
      return null;
    }
  };

  const render = async (submitted: boolean): Promise<void> => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) {
      out.innerHTML = idle;
      return;
    }
    const ix = await loadIndex();
    if (mine !== seq) return;
    const groups = ix ? localHits(ix, q) : [];
    const frag = document.createDocumentFragment();
    let nsnHits: Hit[] = [];
    let note: HTMLParagraphElement | null = null;

    if (looksLikeId(q) || submitted) {
      const r = await lookup(q);
      if (mine !== seq) return;
      if (!r) note = message('Lookup is temporarily unavailable. Please try again shortly.', true);
      else if (r.ok && r.matches.length === 1 && submitted) {
        window.location.href = `/nsn/${r.matches[0]}/`;
        return;
      } else if (r.ok && r.matches.length > 0) {
        nsnHits = r.matches.slice(0, 8).map((d) => ({ href: `/nsn/${d}/`, code: d, name: r.kind === 'part_number' ? `Carries part number ${q.toUpperCase()}` : 'National stock number' }));
      } else if (submitted || looksLikeId(q)) {
        const digits = q.replace(/\D/g, '');
        const what = r.kind === 'part_number' ? `No indexed NSN references part number “${q}”.` : r.ok ? `${digits.length === 13 ? 'NSN' : 'NIIN'} ${q} is not in the catalog yet.` : '';
        if (what) note = message(what, true);
      }
    }

    frag.append(section('National stock numbers', nsnHits));
    for (const g of groups) frag.append(section(g.title, g.hits));
    const total = nsnHits.length + groups.reduce((n, g) => n + g.hits.length, 0);
    if (note) frag.prepend(note);
    else if (total === 0) frag.append(message(`Nothing matches “${q}”. Try a 13-digit NSN, a part number, or a category name.`));
    out.replaceChildren(frag);
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(false), 220);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    window.clearTimeout(timer);
    // Enter goes to the only result when there is exactly one; otherwise it runs the lookup.
    const links = out.querySelectorAll<HTMLAnchorElement>('a.result');
    if (links.length === 1) window.location.href = links[0].href;
    else void render(true);
  });
  // Arrow keys move through results.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const first = out.querySelector<HTMLAnchorElement>('a.result');
    if (first) { e.preventDefault(); first.focus(); }
  });
  out.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = [...out.querySelectorAll<HTMLAnchorElement>('a.result')];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) input.focus();
    else links[Math.min(links.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
}

/* ---------- in-page tabs: mark the section in view ---------- */
document.querySelectorAll<HTMLElement>('nav.tabs').forEach((nav) => {
  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const targets = links.map((a) => document.getElementById(a.hash.slice(1))).filter((t): t is HTMLElement => !!t);
  if (!targets.length) return;
  const set = (id: string) => {
    for (const a of links) {
      if (a.hash === `#${id}`) {
        if (a.getAttribute('aria-current') !== 'true') {
          a.setAttribute('aria-current', 'true');
          // Keep the active tab in view inside the scrolling bar without moving the page.
          const left = a.offsetLeft - nav.clientWidth / 2 + a.clientWidth / 2;
          nav.scrollTo({ left, behavior: 'smooth' });
        }
      } else a.removeAttribute('aria-current');
    }
  };
  const update = () => {
    const line = (nav.getBoundingClientRect().bottom || 0) + 24;
    let current = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top <= line) current = t;
    set(current.id);
  };
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  update();
});

/* ---------- folded introductions (phones) ---------- */
document.querySelectorAll<HTMLElement>('p.lede:not(:has(~ p.lede)), section.intro > p.gloss').forEach((el) => {
  if (el.scrollHeight <= el.clientHeight + 4) return; // fits, or not folded at this width
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'clamp-more';
  b.textContent = 'More';
  b.addEventListener('click', () => { el.classList.add('open'); b.remove(); });
  el.after(b);
});

/* ---------- long result lists: first sixty rows, then "Show all" ---------- */
document.querySelectorAll<HTMLElement>('.product-grid').forEach((grid) => {
  const total = grid.children.length;
  if (total <= 60) { grid.classList.add('expanded'); return; }
  const wrap = document.createElement('p');
  wrap.className = 'show-all';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost';
  b.textContent = `Show all ${total.toLocaleString('en-US')} on this page`;
  const expand = () => { grid.classList.add('expanded'); wrap.remove(); };
  b.addEventListener('click', expand);
  wrap.append(b);
  grid.after(wrap);
  // Filtering or sorting works on the whole list, so it opens the list first.
  grid.closest('.products-layout')?.querySelector('.filter-rail')?.addEventListener('change', expand);
});
