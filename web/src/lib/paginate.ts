// Pagination helpers shared by the class, open-demand and service pages.
// Pure (no imports) so node --test can load it directly.

/** Cards rendered per page. Keeps the largest page well under Googlebot's 2 MB read limit. */
export const PAGE_SIZE = 500;

/** Number of pages for `total` items; an empty list still has one (empty) page. */
export function pageCount(total: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** 1-based page numbers [1..N] for `total` items. */
export function pageNumbers(total: number, size: number = PAGE_SIZE): number[] {
  return Array.from({ length: pageCount(total, size) }, (_, i) => i + 1);
}

/** Rest-route param for a page: undefined for page 1 (the base URL), 'page/n' otherwise. */
export function pageParam(page: number): string | undefined {
  return page <= 1 ? undefined : `page/${page}`;
}

/** Parses a rest-route param back to a page number (undefined / '' -> 1). */
export function pageFromParam(param: string | undefined): number {
  if (!param) return 1;
  const m = /^page\/(\d+)$/.exec(param);
  return m ? Number(m[1]) : 1;
}

/** URL path for a page. `base` ends with '/' (e.g. '/fsc/5340/'). */
export function pageUrl(base: string, page: number): string {
  return page <= 1 ? base : `${base}page/${page}/`;
}

/** The slice of `items` shown on a 1-based page. */
export function pageItems<T>(items: readonly T[], page: number, size: number = PAGE_SIZE): T[] {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

/** Title for pages >= 2 gets ` (Page n of N)`; page 1 is unchanged. */
export function pagedTitle(title: string, page: number, pages: number): string {
  return page > 1 ? `${title} (Page ${page} of ${pages})` : title;
}

/** Description for pages >= 2 gets the prefix `Page n of N. `; page 1 is unchanged. */
export function pagedDescriptionPrefix(page: number, pages: number): string {
  return page > 1 ? `Page ${page} of ${pages}. ` : '';
}

export interface PagerModel {
  page: number;
  pages: number;
  prev: string | null;
  next: string | null;
  /** Numbered links, only when there are <= 10 pages. */
  numbers: { page: number; href: string; current: boolean }[] | null;
}

export function pagerModel(base: string, page: number, pages: number): PagerModel {
  return {
    page,
    pages,
    prev: page > 1 ? pageUrl(base, page - 1) : null,
    next: page < pages ? pageUrl(base, page + 1) : null,
    numbers:
      pages <= 10
        ? Array.from({ length: pages }, (_, i) => ({
            page: i + 1,
            href: pageUrl(base, i + 1),
            current: i + 1 === page,
          }))
        : null,
  };
}

/** 1-based inclusive item range shown on a page, e.g. {start: 501, end: 1000}. */
export function pageRange(total: number, page: number, size: number = PAGE_SIZE): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  return { start: (page - 1) * size + 1, end: Math.min(total, page * size) };
}

/** "501–1,000" or just "501" when the range is a single item. */
export function rangeLabel(start: number, end: number): string {
  const f = (n: number) => n.toLocaleString('en-US');
  return start === end ? f(start) : `${f(start)}–${f(end)}`;
}
