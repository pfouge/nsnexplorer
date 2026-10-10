// /data/contract-actions-<fsc>.csv — USAspending contract actions recorded
// against one federal supply class (public domain). DIBBS award rows are left
// out on purpose; see lib/csv-tables.ts.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { contractActionHeaders, contractActionRows, usaspendingActionsByFsc } from '../../lib/csv-tables';

export const prerender = true;

export async function getStaticPaths() {
  const data = await loadSiteData();
  return [...usaspendingActionsByFsc(data).keys()].sort().map((fsc) => ({ params: { fsc } }));
}

export const GET: APIRoute = async ({ params }) => {
  const data = await loadSiteData();
  const actions = usaspendingActionsByFsc(data).get(params.fsc ?? '') ?? [];
  return csvResponse(`contract-actions-${params.fsc}.csv`, toCsv(contractActionHeaders, contractActionRows(actions)));
};
