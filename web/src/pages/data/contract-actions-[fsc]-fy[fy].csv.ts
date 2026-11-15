// /data/contract-actions-<fsc>-fy<year>.csv — USAspending contract actions for
// one federal supply class in one federal fiscal year (public domain). Split by
// year because Cloudflare Pages rejects files over 25 MiB; see lib/csv-tables.ts.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { actionsByFiscalYear, contractActionHeaders, contractActionRows, usaspendingActionsByFsc } from '../../lib/csv-tables';

export const prerender = true;

export async function getStaticPaths() {
  const data = await loadSiteData();
  const paths: { params: { fsc: string; fy: string } }[] = [];
  for (const [fsc, actions] of usaspendingActionsByFsc(data)) {
    for (const fy of actionsByFiscalYear(actions).keys()) paths.push({ params: { fsc, fy: String(fy) } });
  }
  return paths;
}

export const GET: APIRoute = async ({ params }) => {
  const data = await loadSiteData();
  const actions = usaspendingActionsByFsc(data).get(params.fsc ?? '') ?? [];
  const rows = actionsByFiscalYear(actions).get(Number(params.fy)) ?? [];
  return csvResponse(`contract-actions-${params.fsc}-fy${params.fy}.csv`, toCsv(contractActionHeaders, contractActionRows(rows)));
};
