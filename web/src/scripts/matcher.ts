// matcher.ts — the home page capability matcher (components/CapabilityMatcher.astro).
// Picks are kept in localStorage under nsn.capabilities (a list of four-digit class codes) and named
// on the privacy page. Data: /data/open-by-class.json, fetched on first use.
interface OpenItem { sol: string; nsn: string | null; name: string | null; qty: number | null; unit: string | null; closes: string | null; setaside: string | null }
interface OpenClass { fsc: string; name: string | null; count: number; qty: number; nextClose: string | null; items: OpenItem[] }

const KEY = 'nsn.capabilities';
const root = document.querySelector<HTMLElement>('[data-matcher]');

if (root) {
  const today = root.dataset.today ?? new Date().toISOString().slice(0, 10);
  const find = root.querySelector<HTMLInputElement>('[data-matcher-find]')!;
  const suggest = root.querySelector<HTMLElement>('[data-matcher-suggest]')!;
  const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-matcher-chips] [data-fsc]')];
  const mine = root.querySelector<HTMLElement>('[data-matcher-mine]')!;
  const mineText = root.querySelector<HTMLElement>('[data-matcher-mine-text]')!;
  const title = root.querySelector<HTMLElement>('[data-matcher-title]')!;
  const classBody = root.querySelector<HTMLElement>('[data-matcher-classes]')!;
  const soonest = root.querySelector<HTMLElement>('[data-matcher-soonest]')!;
  const itemBody = root.querySelector<HTMLElement>('[data-matcher-items]')!;
  const defaultRows = [...classBody.children].map((n) => n.cloneNode(true));
  const defaultTitle = title.textContent;

  const load = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => /^\d{4}$/.test(x)).slice(0, 40) : []; } catch { return []; } };
  const save = (v: string[]) => { try { if (v.length) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* private mode */ } };
  let picks = load();
  let data: OpenClass[] | null = null;
  let loading: Promise<OpenClass[]> | null = null;
  const getData = () => (loading ??= fetch('/data/open-by-class.json').then((r) => r.json()).then((d: OpenClass[]) => (data = d)).catch(() => (data = [])));

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
    const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n;
  };
  const fmt = (n: number) => n.toLocaleString('en-US');
  const day = (iso: string | null) => iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
  const left = (iso: string | null) => iso ? Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
  const dashed = (n: string) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9)}`;

  const render = async () => {
    chips.forEach((c) => c.setAttribute('aria-pressed', String(picks.includes(c.dataset.fsc!))));
    if (!picks.length) {
      mine.hidden = true; soonest.hidden = true;
      title.textContent = defaultTitle;
      classBody.replaceChildren(...defaultRows.map((n) => n.cloneNode(true)));
      return;
    }
    const d = data ?? (await getData());
    const byFsc = new Map(d.map((c) => [c.fsc, c]));
    mine.hidden = false;
    mineText.textContent = `Your classes: ${picks.join(', ')}. `;
    title.textContent = 'Open for bid in your classes';
    const rows = picks.map((f) => byFsc.get(f) ?? { fsc: f, name: null, count: 0, qty: 0, nextClose: null, items: [] });
    classBody.replaceChildren(...rows.map((c) => {
      const l = left(c.nextClose);
      return el('tr', {},
        el('td', {}, el('a', { href: `/open/${c.fsc}/`, textContent: c.fsc }), ' ', el('span', { className: 'cls-name', textContent: c.name ?? '' })),
        el('td', { className: 'num', textContent: c.count ? fmt(c.count) : 'None open' }),
        el('td', { className: 'num', textContent: c.count ? fmt(c.qty) : '' }),
        el('td', {}, c.count ? day(c.nextClose) : '', ...(l !== null && l >= 0 && c.count ? [el('span', { className: 'soft', textContent: ` · ${l} d` })] : [])),
      );
    }));
    const items = rows.flatMap((c) => c.items.map((i) => ({ ...i, fsc: c.fsc })))
      .sort((a, b) => (a.closes ?? '9999').localeCompare(b.closes ?? '9999')).slice(0, 10);
    soonest.hidden = items.length === 0;
    itemBody.replaceChildren(...items.map((i) => el('tr', {},
      el('td', {}, el('a', { href: `/solicitation/${encodeURIComponent(i.sol)}/`, textContent: i.sol })),
      el('td', {}, i.nsn ? el('a', { href: `/nsn/${dashed(i.nsn)}/`, textContent: i.name ?? dashed(i.nsn) }) : (i.name ?? '')),
      el('td', { className: 'num', textContent: i.qty !== null ? `${fmt(i.qty)}${i.unit ? ' ' + i.unit : ''}` : '—' }),
      el('td', { textContent: day(i.closes) }),
    )));
  };

  const toggle = (fsc: string) => {
    picks = picks.includes(fsc) ? picks.filter((p) => p !== fsc) : [...picks, fsc];
    save(picks); void render();
  };
  chips.forEach((c) => c.addEventListener('click', () => toggle(c.dataset.fsc!)));
  root.querySelector('[data-matcher-clear]')!.addEventListener('click', () => { picks = []; save(picks); void render(); });

  // Class finder: names and codes from the same file.
  const showSuggest = async () => {
    const q = find.value.trim().toLowerCase();
    if (q.length < 2) { suggest.hidden = true; return; }
    const d = data ?? (await getData());
    const hits = d.filter((c) => c.fsc.startsWith(q) || (c.name ?? '').toLowerCase().includes(q)).slice(0, 8);
    suggest.replaceChildren(...(hits.length ? hits.map((c) => {
      const b = el('button', { type: 'button', className: 'opt' }, `${c.fsc} ${c.name ?? ''}`, el('span', { className: 'n', textContent: ` ${fmt(c.count)} open` }));
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(picks.includes(c.fsc)));
      b.addEventListener('click', () => { if (!picks.includes(c.fsc)) toggle(c.fsc); find.value = ''; suggest.hidden = true; find.focus(); });
      return b;
    }) : [el('p', { className: 'none', textContent: 'No class with open bids matches that.' })]));
    suggest.hidden = false;
  };
  find.addEventListener('focus', () => void getData());
  find.addEventListener('input', () => void showSuggest());
  find.addEventListener('keydown', (e) => { if (e.key === 'Escape') { suggest.hidden = true; } if (e.key === 'ArrowDown') suggest.querySelector<HTMLElement>('.opt')?.focus(); });
  suggest.addEventListener('keydown', (e) => {
    const opts = [...suggest.querySelectorAll<HTMLElement>('.opt')]; const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? find : opts[i - 1]).focus(); }
    if (e.key === 'Escape') { suggest.hidden = true; find.focus(); }
  });
  document.addEventListener('click', (e) => { if (!root.querySelector('.matcher-find')!.contains(e.target as Node)) suggest.hidden = true; });

  if (picks.length) void render();
}
