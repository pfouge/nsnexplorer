// /data/contract-actions-<fsc>.csv — the latest 12 months of USAspending contract
// actions recorded against one federal supply class (public domain). Full
// history is in the per-fiscal-year files (contract-actions-<fsc>-fy<year>.csv). DIBBS award rows are left
// out on purpose; see lib/csv-tables.ts.
// The rows are read from the database one file at a time (lib/class-actions-csv.ts)
// instead of holding every class-level action in memory.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { contractActionHeaders, usaspendingCsvClasses } from '../../lib/csv-tables';
import { latestYearCsvRows } from '../../lib/class-actions-csv';

export const prerender = true;

export async function getStaticPaths() {
  const data = await loadSiteData();
  return [...usaspendingCsvClasses(data).keys()].sort().map((fsc) => ({ params: { fsc } }));
}

export const GET: APIRoute = async ({ params }) => {
  const data = await loadSiteData();
  const rows = await latestYearCsvRows(params.fsc ?? '', data.contractActionNsnIds);
  return csvResponse(`contract-actions-${params.fsc}.csv`, toCsv(contractActionHeaders, rows));
};
