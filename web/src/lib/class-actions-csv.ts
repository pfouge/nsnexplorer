// class-actions-csv.ts — the database handle for the prerendered contract-action CSV endpoints.
//
// Those endpoints run at build time only (prerender = true), so they may use
// `pg`. They share ONE pool (openPool: at most DB_POOL_MAX, default 4
// connections, the same limit as loadSiteData) and open it on first use.
// Idle clients are closed by pg's default idle timeout, so the build can exit.

import type pgTypes from 'pg';
import { openPool } from './data';
import { loadFiscalYearCsvRows, loadLatestYearCsvRows } from './class-actions-db';
import { latestYearFloor } from './csv-split';

let pool: Promise<pgTypes.Pool> | null = null;
const csvPool = () => (pool ??= openPool());

/** Rows of /data/contract-actions-<fsc>.csv (CSV cells, in file order). */
export async function latestYearCsvRows(fsc: string, nsnActionIds: number[]) {
  return loadLatestYearCsvRows(await csvPool(), fsc, nsnActionIds, latestYearFloor());
}

/** Rows of /data/contract-actions-<fsc>-fy<fy>.csv. */
export async function fiscalYearCsvRows(fsc: string, nsnActionIds: number[], fy: number) {
  return loadFiscalYearCsvRows(await csvPool(), fsc, nsnActionIds, fy);
}
