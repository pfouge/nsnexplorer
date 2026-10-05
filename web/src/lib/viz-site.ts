// lib/viz-site.ts — pure number-crunching for the site-wide charts: the demand
// tape, the headline tiles with their trend lines, the data-freshness strip
// and the demand map by supply group. No pg, no DOM: it runs at build time,
// in the browser (tape and freshness scripts import it) and under node --test.

import { daysBetween, fmtInt, fmtUsd, monthDay, round, seqBin, treemap, type TreeRect } from './viz.ts';

// ---------------------------------------------------------------- tape

export interface TapeItem {
  fsc: string;
  name: string;
  quantity: number | null;
  issuedOn: string | null;
  returnBy: string | null;
  source: string;
  /** dashed NSN, '5340-00-123-4567' */
  nsn: string;
}

export const TAPE_MIN_ITEMS = 6;
export const TAPE_SOON_DAYS = 3;

export function sourceLabel(source: string): string {
  return source === 'sam_gov' ? 'SAM.gov' : 'DIBBS';
}

/** Status shown on a tape item, or null when the item has already closed at `today`. */
export function tapeStatus(
  item: Pick<TapeItem, 'issuedOn' | 'returnBy'>,
  today: string
): { cls: 'soon' | 'new'; text: string } | null {
  if (item.returnBy) {
    const d = daysBetween(today, item.returnBy);
    if (d < 0) return null;
    if (d <= TAPE_SOON_DAYS) return { cls: 'soon', text: d === 0 ? 'closes today' : `closes in ${d}d` };
  }
  return { cls: 'new', text: item.issuedOn ? `posted ${monthDay(item.issuedOn)}` : 'open now' };
}

/** Items still worth showing at `today`; null when fewer than the minimum remain. */
export function tapeItems(items: TapeItem[], today: string): TapeItem[] | null {
  const live = items.filter((i) => tapeStatus(i, today) !== null);
  return live.length >= TAPE_MIN_ITEMS ? live : null;
}

// ---------------------------------------------------------------- headline tiles

export interface DailyStatRow {
  day: string; // ISO date
  open: number;
  posted: number;
  closing7: number;
  awards7: number;
}
export type TileKey = 'open' | 'posted' | 'closing7' | 'awards7';

export const TREND_MIN_ROWS = 7;
export const TREND_MAX_ROWS = 90;

/** Trend values (oldest first, at most 90) or null when fewer than 7 daily rows exist. */
export function trendSeries(rows: DailyStatRow[], key: TileKey): { days: string[]; values: number[] } | null {
  if (rows.length < TREND_MIN_ROWS) return null;
  const used = [...rows].sort((a, b) => a.day.localeCompare(b.day)).slice(-TREND_MAX_ROWS);
  return { days: used.map((r) => r.day), values: used.map((r) => r[key]) };
}

export interface WeekDelta {
  dir: 'up' | 'down' | 'flat';
  text: string;
}
/** Newest row against the row exactly 7 days before it; null when that row is missing. */
export function weekDelta(rows: DailyStatRow[], key: TileKey, fmt: (n: number) => string = fmtInt): WeekDelta | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const newest = sorted[sorted.length - 1];
  const earlier = sorted.find((r) => daysBetween(r.day, newest.day) === 7);
  if (!earlier) return null;
  const diff = newest[key] - earlier[key];
  if (diff === 0) return { dir: 'flat', text: 'no change vs a week earlier' };
  const mark = diff > 0 ? '▲' : '▼';
  return { dir: diff > 0 ? 'up' : 'down', text: `${mark} ${fmt(Math.abs(diff))} vs a week earlier` };
}

export interface Spark {
  line: string;
  area: string;
  last: { x: number; y: number };
}
/** Path data for a w x h sparkline. Flat series draw mid-height. */
export function sparkPath(values: number[], w = 200, h = 36, padX = 4, padY = 5): Spark | null {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => padX + (i * (w - 2 * padX)) / (values.length - 1);
  const y = (v: number) => (hi === lo ? h / 2 : h - padY - ((v - lo) / (hi - lo)) * (h - 2 * padY));
  const pts = values.map((v, i) => [round(x(i)), round(y(v))] as const);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join('');
  const area = `${line}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z`;
  return { line, area, last: { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] } };
}

export interface TileModel {
  key: TileKey;
  label: string;
  value: string;
  delta: WeekDelta | null;
  spark: (Spark & { aria: string; tip: string }) | null;
}

export interface TileInput {
  open: number;
  posted: number;
  postedOn: string | null;
  closing7: number;
  awards7: number;
}

export function buildTiles(live: TileInput, rows: DailyStatRow[]): TileModel[] {
  const defs: { key: TileKey; label: string; raw: number; fmt: (n: number) => string; noun: string }[] = [
    { key: 'open', label: 'Open solicitations', raw: live.open, fmt: fmtInt, noun: 'open solicitations' },
    {
      key: 'posted',
      label: 'Posted in the last 7 days',
      raw: live.posted,
      fmt: fmtInt,
      noun: 'posted in the last 7 days',
    },
    { key: 'closing7', label: 'Closing in the next 7 days', raw: live.closing7, fmt: fmtInt, noun: 'closing within 7 days' },
    { key: 'awards7', label: 'Award dollars, last 7 days', raw: live.awards7, fmt: fmtUsd, noun: 'in award dollars over the prior 7 days' },
  ];
  return defs.map((d) => {
    const series = trendSeries(rows, d.key);
    const path = series ? sparkPath(series.values) : null;
    let spark: TileModel['spark'] = null;
    if (series && path) {
      const first = series.values[0];
      const last = series.values[series.values.length - 1];
      spark = {
        ...path,
        aria: `${d.label}, last ${series.values.length} days: ${d.fmt(first)} on ${monthDay(series.days[0])}, ${d.fmt(last)} on ${monthDay(series.days[series.days.length - 1])}`,
        tip: `${d.label}\nLast ${series.values.length} days: ${d.fmt(first)} (${monthDay(series.days[0])}) to ${d.fmt(last)} (${monthDay(series.days[series.days.length - 1])})`,
      };
    }
    return {
      key: d.key,
      label: d.label,
      value: d.fmt(d.raw),
      delta: series ? weekDelta(rows, d.key, d.fmt) : null,
      spark,
    };
  });
}

// ---------------------------------------------------------------- freshness

export interface FreshnessSource {
  key: string;
  label: string;
  /** ISO timestamp of the newest record to land */
  lastLanded: string;
  limitHours: number;
  cadence: string;
}

export interface FreshnessView {
  late: boolean;
  symbol: string;
  age: string;
  widthPct: number;
  meterLabel: string;
}

export function freshnessView(lastLandedIso: string, limitHours: number, nowMs: number): FreshnessView | null {
  const t = Date.parse(lastLandedIso);
  if (Number.isNaN(t)) return null;
  const hours = Math.max(0, (nowMs - t) / 3600000);
  let age: string;
  if (hours < 1) age = 'less than an hour ago';
  else if (hours < 24) {
    const h = Math.floor(hours);
    age = `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  } else {
    const d = Math.floor(hours / 24);
    age = d === 1 ? 'yesterday' : `${d} days ago`;
  }
  const ratio = limitHours > 0 ? hours / limitHours : 0;
  const late = hours > limitHours;
  const widthPct = Math.min(100, Math.round(ratio * 100));
  return {
    late,
    symbol: late ? '◐' : '✓',
    age: `updated ${age}`,
    widthPct,
    meterLabel: `${widthPct} percent of this source's normal update window`,
  };
}

// ---------------------------------------------------------------- demand map

export interface GroupDemandRow {
  fsg: string;
  open: number;
  closing7: number;
}
export interface DemandTile {
  /** null for the "Other groups" tile */
  fsg: string | null;
  name: string;
  open: number;
  closing7: number;
  /** share of this tile's open solicitations that close within 7 days, 0..1 */
  share: number;
  bin: number;
  href: string | null;
  /** number of groups folded in (1 for a single group) */
  groups: number;
}

export const DEMAND_MAP_MIN_GROUPS = 3;
export const DEMAND_MAP_MAX_TILES = 13;

/**
 * Tiles for the demand map: the 13 largest groups plus "Other groups" (when
 * more than 14 groups exist, otherwise every group). null below 3 groups.
 */
export function buildDemandTiles(
  rows: GroupDemandRow[],
  groupName: (fsg: string) => string,
  hasPage: (fsg: string) => boolean
): DemandTile[] | null {
  const live = rows.filter((r) => r.open > 0);
  if (live.length < DEMAND_MAP_MIN_GROUPS) return null;
  const sorted = [...live].sort((a, b) => b.open - a.open || a.fsg.localeCompare(b.fsg));
  const keep = sorted.length > DEMAND_MAP_MAX_TILES + 1 ? sorted.slice(0, DEMAND_MAP_MAX_TILES) : sorted;
  const rest = sorted.slice(keep.length);
  const tiles: Omit<DemandTile, 'bin'>[] = keep.map((r) => ({
    fsg: r.fsg,
    name: groupName(r.fsg),
    open: r.open,
    closing7: r.closing7,
    share: r.closing7 / r.open,
    href: hasPage(r.fsg) ? `/group/${r.fsg}/` : null,
    groups: 1,
  }));
  if (rest.length > 0) {
    const open = rest.reduce((a, r) => a + r.open, 0);
    const closing7 = rest.reduce((a, r) => a + r.closing7, 0);
    tiles.push({ fsg: null, name: 'Other groups', open, closing7, share: closing7 / open, href: null, groups: rest.length });
  }
  const maxShare = Math.max(...tiles.map((t) => t.share));
  return tiles
    .map((t) => ({ ...t, bin: seqBin(t.share, maxShare) }))
    // Largest first, but the "Other groups" remainder always goes last so a
    // catch-all never takes the lead position.
    .sort((a, b) => Number(a.fsg === null) - Number(b.fsg === null) || b.open - a.open || (a.fsg ?? '~').localeCompare(b.fsg ?? '~'));
}

export function layoutDemandTiles(tiles: DemandTile[], w: number, h: number): TreeRect<DemandTile & { value: number }>[] {
  return treemap(tiles.map((t) => ({ ...t, value: t.open })), 0, 0, w, h);
}

const CHAR_PX = 6.3;
const LABEL_PAD = 14;
/** Whether `str` fits a tile `w` wide (6.3px a character plus 14 of padding). */
export const labelFits = (str: string, w: number): boolean => w >= str.length * CHAR_PX + LABEL_PAD;

/** One or two label lines for a tile: `NN Group Name`, then `FSG NN`, then nothing. */
export function tileLabels(tile: Pick<DemandTile, 'fsg' | 'name' | 'open'>, w: number, h: number): { line1: string | null; line2: string | null } {
  let line1: string | null = null;
  if (h > 24) {
    const full = tile.fsg ? `${tile.fsg} ${tile.name}` : tile.name;
    if (labelFits(full, w)) line1 = full;
    else {
      // Shorten the name to what fits ("59 Electrical and Elec…") before
      // falling back to the bare group code.
      const room = Math.floor((w - 14) / 6.3) - 1;
      if (room >= 12) line1 = `${full.slice(0, room).replace(/[\s,]+$/, '')}…`;
      else if (tile.fsg && labelFits(`FSG ${tile.fsg}`, w)) line1 = `FSG ${tile.fsg}`;
    }
  }
  const count = `${fmtInt(tile.open)} open`;
  const line2 = line1 && h > 40 && labelFits(count, w) ? count : null;
  return { line1, line2 };
}
