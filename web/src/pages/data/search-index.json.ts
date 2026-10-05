// /data/search-index.json — the small list the header search filters in the
// browser: supply classes, supply groups, agencies and service categories.
// NSNs and part numbers are far too many for a file; those go to
// /api/lookup.json. Prerendered at build time.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { buildDepartments, fscDisplayName } from '../../lib/browse';
import { serviceCategoryName } from '../../lib/services';

export const prerender = true;

export interface SearchIndex {
  /** [code, name, open solicitations, has /open/ page, has /fsc/ page] */
  classes: [string, string, number, 0 | 1, 0 | 1][];
  /** [group code, name] */
  groups: [string, string][];
  /** [slug, name] */
  agencies: [string, string][];
  /** [url key, name, open notices] */
  services: [string, string, number][];
}

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  const priced = new Set(data.deepFscs.map((f) => f.fsc));
  const names = new Map<string, string | null>();
  for (const f of data.deepFscs) names.set(f.fsc, f.name);
  for (const [fsc, entry] of data.solicitationsByFsc) if (!names.get(fsc)) names.set(fsc, entry.name);

  const index: SearchIndex = {
    classes: [...names.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fsc, name]) => [
        fsc,
        fscDisplayName(fsc, name),
        data.openByFsc.get(fsc)?.solicitations.length ?? 0,
        data.solicitationsByFsc.has(fsc) ? 1 : 0,
        priced.has(fsc) ? 1 : 0,
      ]),
    groups: buildDepartments(data).map((d) => [d.fsg, d.name]),
    agencies: data.agencies.map((a) => [a.slug, a.name]),
    services: [...data.serviceNoticesByCategory.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([key, list]) => [key === 'other' ? 'other' : key.toLowerCase(), key === 'other' ? 'Other services' : serviceCategoryName(key), list.length]),
  };
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
