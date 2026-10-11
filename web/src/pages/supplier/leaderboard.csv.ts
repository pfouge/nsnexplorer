// /supplier/leaderboard.csv — every ranked list on /supplier/ (top 100 per list,
// one row per list and supplier). Totals computed by pub.refresh_supplier_stats()
// from indexed award records; no contact details. Prerendered at build time.
import type { APIRoute } from 'astro';
import { csvResponse, toCsv } from '../../lib/csv';
import { leaderboardHeaders, leaderboardRows } from '../../lib/supplier-board';
import { loadSupplierBoard } from '../../lib/supplier-board-data';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSupplierBoard();
  return csvResponse('supplier-leaderboard.csv', toCsv(leaderboardHeaders, leaderboardRows(data)));
};
