// /data/agencies.csv — one row per agency on /agencies/ (totals only).
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { agenciesHeaders, agenciesRows } from '../../lib/csv-tables';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return csvResponse('agencies.csv', toCsv(agenciesHeaders, agenciesRows(data)));
};
