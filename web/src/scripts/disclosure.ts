// disclosure.ts — progressive disclosure that never removes anything from the page (design/system.md).
//
// 1. Group tabs: <div data-group-tabs="<page type>"> holds buttons with data-tab="<group>" (and one
//    data-tab="all"); sections carry data-group="<group>". One group shows at a time; "All" shows every
//    group. The choice is kept for the visit in sessionStorage (nsn.tab.<page type>). Without JavaScript
//    every group shows.
// 2. Row folds: <table class="rows-fold"> shows its first rows; a "Show all N rows" button opens it.
//    Every row stays in the HTML.
// 3. Sortable tables: <table data-sortable> gets a sort button in each <th data-sort="num|text|date">.
// 4. Row density: [data-density-toggle] buttons switch comfortable / compact for the visit (nsn.density).
// 5. Reveal: any link or URL hash that points inside a hidden group, a closed <details> or a folded row
//    switches the tab, opens the fold, shows the row, then scrolls to it.

const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* ---------- 1. group tabs ---------- */
type Tabset = { bar: HTMLElement; key: string; show: (g: string, remember?: boolean) => void };
const tabsets: Tabset[] = [];
document.querySelectorAll<HTMLElement>('[data-group-tabs]').forEach((bar) => {
  const key = `nsn.tab.${bar.dataset.groupTabs || 'page'}`;
  const scope = bar.closest('main') ?? document;
  const groups = [...scope.querySelectorAll<HTMLElement>('[data-group]')];
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  if (!groups.length || !buttons.length) return;
  bar.hidden = false;
  bar.setAttribute('role', 'tablist');
  const show = (g: string, remember = true) => {
    if (!buttons.some((b) => b.dataset.tab === g)) g = buttons[0].dataset.tab!;
    buttons.forEach((b) => {
      const on = b.dataset.tab === g;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    groups.forEach((s) => { s.hidden = !(g === 'all' || s.dataset.group === g); });
    if (remember) ss.set(key, g);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => show(b.dataset.tab!));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = buttons[(i + d + buttons.length) % buttons.length];
      n.focus(); show(n.dataset.tab!);
    });
  });
  show(ss.get(key) ?? bar.dataset.default ?? buttons[0].dataset.tab!, false);
  document.getElementById(`gt-pre-${bar.dataset.groupTabs}`)?.remove(); // the pre-paint style from GroupTabs.astro
  tabsets.push({ bar, key, show });
});

/* ---------- 2. row folds ---------- */
document.querySelectorAll<HTMLTableElement>('table.rows-fold').forEach((t) => {
  const rows = t.tBodies[0]?.rows.length ?? 0;
  const first = Number(t.dataset.rows || 5);
  if (rows <= first) { t.classList.add('open'); return; }
  const bar = document.createElement('div');
  bar.className = 'rows-more';
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `Show all ${rows.toLocaleString('en-US')} rows`;
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', () => {
    const open = !t.classList.contains('open');
    t.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? `Show the first ${first} rows` : `Show all ${rows.toLocaleString('en-US')} rows`;
    if (!open) t.scrollIntoView({ block: 'nearest' });
  });
  bar.append(b);
  (t.closest('.table-wrap') ?? t).after(bar);
});

/* ---------- 2b. list folds: <div class="list-fold"> shows its first ten children ---------- */
document.querySelectorAll<HTMLElement>('.list-fold').forEach((list) => {
  const n = list.children.length;
  if (n <= 10) { list.classList.add('open'); return; }
  const bar = document.createElement('div');
  bar.className = 'rows-more';
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `Show all ${n.toLocaleString('en-US')}`;
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', () => {
    const open = !list.classList.contains('open');
    list.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? 'Show the first 10' : `Show all ${n.toLocaleString('en-US')}`;
  });
  bar.append(b);
  list.after(bar);
});

/* ---------- 3. sortable tables ---------- */
const cellValue = (td: HTMLTableCellElement | undefined, kind: string) => {
  const raw = (td?.dataset.v ?? td?.textContent ?? '').trim();
  if (kind === 'num') { const n = Number(raw.replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && raw !== '' && raw !== '—' ? n : -Infinity; }
  if (kind === 'date') { const n = Date.parse(raw); return Number.isFinite(n) ? n : -Infinity; }
  return raw.toLowerCase();
};
document.querySelectorAll<HTMLTableElement>('table[data-sortable]').forEach((t) => {
  const heads = [...(t.tHead?.rows[0]?.cells ?? [])] as HTMLTableCellElement[];
  heads.forEach((th, col) => {
    const kind = th.dataset.sort;
    if (!kind) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sort';
    btn.append(...th.childNodes);
    th.append(btn);
    th.setAttribute('aria-sort', 'none');
    btn.addEventListener('click', () => {
      const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
      heads.forEach((h) => h.dataset.sort && h.setAttribute('aria-sort', 'none'));
      th.setAttribute('aria-sort', dir);
      const body = t.tBodies[0];
      const rows = [...body.rows];
      rows.sort((a, b) => {
        const x = cellValue(a.cells[col], kind), y = cellValue(b.cells[col], kind);
        const c = x < y ? -1 : x > y ? 1 : 0;
        return dir === 'ascending' ? c : -c;
      });
      body.append(...rows);
    });
  });
});

/* ---------- 4. row density ---------- */
const root = document.documentElement;
const applyDensity = (d: string) => {
  if (d === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  document.querySelectorAll<HTMLButtonElement>('[data-density-toggle] button').forEach((b) => b.setAttribute('aria-pressed', String(b.value === (d || 'comfortable'))));
};
applyDensity(ss.get('nsn.density') ?? 'comfortable');
document.querySelectorAll<HTMLElement>('[data-density-toggle]').forEach((g) => {
  g.hidden = false;
  g.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    ss.set('nsn.density', b.value); applyDensity(b.value);
  });
});

/* ---------- 5. reveal whatever a link points at ---------- */
export function reveal(el: Element | null): boolean {
  if (!el) return false;
  const group = el.closest<HTMLElement>('[data-group]');
  if (group?.hidden) {
    const ts = tabsets.find((s) => s.bar.closest('main')?.contains(group));
    ts?.show(group.dataset.group!, true);
  }
  for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) (d as HTMLDetailsElement).open = true;
  if (el instanceof HTMLDetailsElement) el.open = true;
  const t = el.closest('table.rows-fold');
  if (t && !t.classList.contains('open')) {
    const btn = (t.closest('.table-wrap') ?? t).nextElementSibling?.querySelector<HTMLButtonElement>('.rows-more button, button');
    if (btn) btn.click(); else t.classList.add('open');
  }
  const lf = el.closest('.list-fold:not(.open)');
  if (lf) (lf.nextElementSibling?.querySelector('button') as HTMLButtonElement | null)?.click();
  const fold = el.closest('.product-grid:not(.expanded)');
  if (fold) fold.classList.add('expanded');
  return true;
}
const byHash = (h: string) => { try { return h.length > 1 ? document.getElementById(decodeURIComponent(h.slice(1))) : null; } catch { return null; } };
const go = (h: string, smooth = true) => {
  const el = byHash(h);
  if (!reveal(el)) return;
  requestAnimationFrame(() => el!.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
};
if (location.hash) go(location.hash, false);
window.addEventListener('hashchange', () => go(location.hash));
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!a || a.closest('[data-group-tabs]')) return;
  const el = byHash(a.getAttribute('href')!);
  if (el && (el.closest('[hidden]') || el.closest('details:not([open])') || el.closest('table.rows-fold:not(.open)'))) {
    reveal(el);
  }
});
