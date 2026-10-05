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
/** Pixel width a label line is allowed inside a tile `w` wide. */
export const labelRoom = (w: number): number => w - LABEL_PAD;
/** Estimated pixel width of a label line. */
export const labelWidth = (str: string): number => str.length * CHAR_PX;
export const labelFits = (str: string, w: number): boolean => w >= str.length * CHAR_PX + LABEL_PAD;

/**
 * Plain-English labels for the supply groups, short enough to read on a
 * chart tile. The official group title ("Electrical and Electronic Equipment
 * Components") stays in the tooltip and on the group page; these are display
 * labels only.
 */
export const FSG_SHORT: Record<string, string> = {
  '10': 'Weapons', '11': 'Nuclear ordnance', '12': 'Fire control equipment', '13': 'Ammunition and explosives',
  '14': 'Guided missiles', '15': 'Airframe parts', '16': 'Aircraft components', '17': 'Aircraft ground equipment',
  '18': 'Space vehicles', '19': 'Ships and small craft', '20': 'Ship and marine equipment', '22': 'Railway equipment',
  '23': 'Vehicles and trailers', '24': 'Tractors', '25': 'Vehicle parts', '26': 'Tires and tubes',
  '28': 'Engines and turbines', '29': 'Engine accessories', '30': 'Power transmission', '31': 'Bearings',
  '32': 'Woodworking machinery', '34': 'Metalworking machinery', '35': 'Service and trade equipment',
  '36': 'Special industry machinery', '37': 'Agricultural machinery', '38': 'Construction and mining equipment',
  '39': 'Materials handling', '40': 'Rope, cable and chain', '41': 'Refrigeration and A/C',
  '42': 'Fire, rescue and safety', '43': 'Pumps and compressors', '44': 'Furnaces and dryers',
  '45': 'Plumbing and heating', '46': 'Water purification', '47': 'Pipe, hose and fittings', '48': 'Valves',
  '49': 'Maintenance shop equipment', '51': 'Hand tools', '52': 'Measuring tools', '53': 'Hardware and abrasives',
  '54': 'Prefabricated structures', '55': 'Lumber and millwork', '56': 'Construction materials',
  '58': 'Communication and detection', '59': 'Electrical components', '60': 'Fiber optics',
  '61': 'Electric wire and power', '62': 'Lighting', '63': 'Alarms and signals', '65': 'Medical and dental supplies',
  '66': 'Instruments and lab equipment', '67': 'Photographic equipment', '68': 'Chemicals', '69': 'Training aids',
  '70': 'IT equipment', '71': 'Furniture', '72': 'Household furnishings', '73': 'Food service equipment',
  '74': 'Office machines', '75': 'Office supplies', '76': 'Books and maps', '77': 'Musical instruments and radios',
  '78': 'Recreational equipment', '79': 'Cleaning equipment', '80': 'Paints, brushes and sealers',
  '81': 'Containers and packaging', '83': 'Textiles, leather and tents', '84': 'Clothing and gear',
  '85': 'Toiletries', '87': 'Agricultural supplies', '88': 'Live animals', '89': 'Food',
  '91': 'Fuels and lubricants', '93': 'Nonmetallic materials', '94': 'Nonmetallic crude materials',
  '95': 'Metal bars and sheets', '96': 'Ores and minerals', '99': 'Miscellaneous',
};

const LINE_PX = 14;

/**
 * Label lines for a tile. The name is always words, never a bare code: the
 * short English label, wrapped over up to three lines to fit the tile, with
 * an ellipsis only when even that will not fit. A tile too small for a
 * readable word gets no label (its tooltip still names it). `count` is the
 * "N open" line, shown when there is room under the name.
 */
export function tileLabels(tile: Pick<DemandTile, 'fsg' | 'name' | 'open'>, w: number, h: number): { lines: string[]; count: string | null } {
  const maxChars = Math.floor((w - LABEL_PAD) / CHAR_PX);
  const rows = Math.floor((h - 10) / LINE_PX);
  if (rows < 1 || maxChars < 5) return { lines: [], count: null };
  const name = (tile.fsg && FSG_SHORT[tile.fsg]) || tile.name;
  const maxLines = Math.max(1, Math.min(3, rows - 1));
  // A single word may run up to 20% over the line; the chart squeezes that
  // line slightly (SVG textLength) instead of cutting the word.
  const softMax = Math.floor(maxChars * 1.2);
  const lines: string[] = [];
  let truncated = false;
  for (const word of name.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
    else if (lines.length < maxLines) lines.push(word);
    else {
      truncated = true;
      break;
    }
  }
  // Clip any line that is still too long (one long word, or the cut-off tail).
  for (let i = 0; i < lines.length; i += 1) {
    const isLast = i === lines.length - 1;
    const limit = lines[i].includes(' ') ? maxChars : softMax;
    if (lines[i].length > limit || (isLast && truncated)) {
      const room = Math.max(1, maxChars - 1);
      lines[i] = `${lines[i].slice(0, lines[i].length > limit ? room : Math.min(lines[i].length, room)).replace(/[\s,]+$/, '')}…`;
    }
  }
  const countText = `${fmtInt(tile.open)} open`;
  const count = rows >= lines.length + 1 && labelFits(countText, w) ? countText : null;
  return { lines, count };
}
