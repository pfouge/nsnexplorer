// /data/classes.csv — one row per federal supply class on /catalog/. The
// site's own counts; no row-level solicitation or award records.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { classesHeaders, classesRows } from '../../lib/csv-tables';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return csvResponse('classes.csv', toCsv(classesHeaders, classesRows(data)));
};
