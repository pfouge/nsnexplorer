// /data/contract-actions-<fsc>-fy<year>.csv — USAspending contract actions for
// one federal supply class in one federal fiscal year (public domain). Split by
// year because Cloudflare Pages rejects files over 25 MiB; see lib/csv-tables.ts.
// One database query per file (lib/class-actions-csv.ts); the fiscal years per class come from SQL aggregates.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { csvResponse, toCsv } from '../../lib/csv';
import { contractActionHeaders, usaspendingCsvClasses } from '../../lib/csv-tables';
import { fiscalYearCsvRows } from '../../lib/class-actions-csv';

export const prerender = true;

export async function getStaticPaths() {
  const data = await loadSiteData();
  const paths: { params: { fsc: string; fy: string } }[] = [];
  for (const [fsc, years] of usaspendingCsvClasses(data)) {
    for (const fy of years) paths.push({ params: { fsc, fy: String(fy) } });
  }
  return paths;
}

export const GET: APIRoute = async ({ params }) => {
  const data = await loadSiteData();
  const rows = await fiscalYearCsvRows(params.fsc ?? '', data.contractActionNsnIds, Number(params.fy));
  return csvResponse(`contract-actions-${params.fsc}-fy${params.fy}.csv`, toCsv(contractActionHeaders, rows));
};
