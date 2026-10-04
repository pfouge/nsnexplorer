// Browser-side helper for paginated card grids (class, open-demand and service
// pages). Each page server-renders one slice of the category. Filters and sorts
// must span the WHOLE category, so on the first filter/sort interaction (not on
// load) the other pages are fetched, parsed and merged into the grid; the page's
// own filter/sort engine then runs over the full set.

const CONCURRENCY = 4;
const fmt = (n: number) => n.toLocaleString('en-US');

/** "501–1,000" or just "501" for a single item (mirrors paginate.rangeLabel). */
export const rangeLabel = (start: number, end: number) => (start === end ? fmt(start) : `${fmt(start)}–${fmt(end)}`);

export const LOAD_ERROR_TEXT = 'Could not load all items. Filters apply to this page only.';

export interface PagedLoaderOptions {
  grid: HTMLElement;
  /** The page's card elements, in server order. Mutated in place once all pages load. */
  cards: HTMLElement[];
  countEl: HTMLElement | null;
  pager: HTMLElement | null;
}

export interface PagedLoader {
  /** True when this page already holds the whole category (single page, or all pages merged). */
  readonly complete: boolean;
  readonly failed: boolean;
  readonly loading: boolean;
  /** Fetches and merges the other pages once; resolves (never rejects) when finished or failed. */
  ensureAll(): Promise<void>;
  /** Writes the counter text, appending the failure notice when loading failed. */
  setCount(text: string): void;
}

/** Reads the pagination contract the server emits as data attributes on #product-grid. */
export function readPagedConfig(grid: HTMLElement) {
  const pages = Number(grid.dataset.pages ?? 1);
  return {
    page: Number(grid.dataset.page ?? 1),
    pages,
    base: grid.dataset.base ?? '',
    total: Number(grid.dataset.total ?? grid.querySelectorAll('.product-card').length),
  };
}

export function createPagedLoader(opts: PagedLoaderOptions): PagedLoader {
  const { grid, cards, countEl, pager } = opts;
  const cfg = readPagedConfig(grid);
  let complete = cfg.pages <= 1;
  let failed = false;
  let loading = false;
  let inflight: Promise<void> | null = null;

  const pageUrl = (p: number) => (p <= 1 ? cfg.base : `${cfg.base}page/${p}/`);

  const fetchPage = async (p: number): Promise<HTMLElement[]> => {
    const res = await fetch(pageUrl(p), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const parsed = doc.getElementById('product-grid');
    if (!parsed) throw new Error('no grid');
    return Array.from(parsed.querySelectorAll<HTMLElement>(':scope > .product-card'));
  };

  const loadAll = async () => {
    loading = true;
    grid.setAttribute('aria-busy', 'true');
    if (countEl) countEl.textContent = `Loading all ${fmt(cfg.total)} items…`;
    const wanted: number[] = [];
    for (let p = 1; p <= cfg.pages; p++) if (p !== cfg.page) wanted.push(p);
    const results = new Map<number, HTMLElement[]>();
    try {
      let next = 0;
      const worker = async () => {
        while (next < wanted.length) {
          const p = wanted[next++];
          results.set(p, await fetchPage(p));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
      // Merge in page order, de-duplicating by the stable card key.
      const seen = new Set<string>();
      const ordered: HTMLElement[] = [];
      const take = (el: HTMLElement) => {
        const key = el.dataset.key ?? '';
        if (key !== '') {
          if (seen.has(key)) return;
          seen.add(key);
        }
        ordered.push(el);
      };
      for (let p = 1; p <= cfg.pages; p++) {
        if (p === cfg.page) cards.forEach(take);
        else (results.get(p) ?? []).forEach((el) => take(document.importNode(el, true) as HTMLElement));
      }
      for (const el of ordered) grid.appendChild(el);
      cards.splice(0, cards.length, ...ordered);
      complete = true;
      if (pager) pager.hidden = true;
      grid.dataset.allLoaded = '1';
    } catch {
      failed = true;
    } finally {
      loading = false;
      grid.removeAttribute('aria-busy');
    }
  };

  const loader: PagedLoader = {
    get complete() { return complete; },
    get failed() { return failed; },
    get loading() { return loading; },
    ensureAll() {
      if (complete || failed) return Promise.resolve();
      if (!inflight) inflight = loadAll();
      return inflight;
    },
    setCount(text: string) {
      if (!countEl) return;
      countEl.textContent = text;
      if (failed) {
        countEl.append(' ');
        const note = document.createElement('span');
        note.className = 'load-error';
        note.style.display = 'block';
        note.textContent = LOAD_ERROR_TEXT;
        countEl.appendChild(note);
      }
    },
  };
  return loader;
}
