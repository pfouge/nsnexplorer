// /data/groups.csv — one row per federal supply group on /catalog/.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { groupsHeaders, groupsRows } from '../../lib/csv-tables';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  return csvResponse('groups.csv', toCsv(groupsHeaders, groupsRows(data)));
};
