// lib/viz-services.ts — pure number-crunching for the three /services/ charts
// (deadline grid, set-aside mix, where-the-work-is map). No pg, no DOM: the
// components in components/viz/ only lay these models out as SVG.
//
// All three count OPEN, CODED service notices (letter category). The uncoded
// 'other' bucket is excluded by the callers and is its own page.

import { FILTER_NONE } from './services.ts';
import { STATE_TILES, daysBetween } from './viz.ts';

export const MIN_CATEGORIES_GRID = 2;
export const MIN_SETASIDE_VALUES = 2;
export const MIN_NOTICES_WITH_STATE = 5;
export const MAX_GRID_ROWS = 12;
export const MAX_SETASIDE_ROWS = 7;
export const OTHER_CATEGORIES = 'Other categories';
export const OTHER_SETASIDES = 'Other set-asides';
export const NO_SETASIDE = 'No set-aside';

export interface NoticeLike {
  category: string;
  closesOn: string | null;
  setaside: string | null;
  state: string | null;
}

// ---------------------------------------------------------------------------
// Deadline grid
// ---------------------------------------------------------------------------

export interface DeadlineWindow {
  key: string;
  /** Column heading. */
  label: string;
  /** Wording inside a tooltip: "N notices closing in <phrase>". */
  phrase: string;
  /** Hash on the category page that applies the matching "Closing within" filter. */
  hash: string;
  /** Highest whole day count (from the build date) that falls in the window. */
  upTo: number;
}

export const DEADLINE_WINDOWS: DeadlineWindow[] = [
  { key: 'w3', label: '≤ 3 days', phrase: '3 days or less', hash: '#within-3', upTo: 3 },
  { key: 'w7', label: '4–7 days', phrase: '4–7 days', hash: '#within-7', upTo: 7 },
  { key: 'w14', label: '8–14 days', phrase: '8–14 days', hash: '#within-30', upTo: 14 },
  { key: 'w30', label: '15–30 days', phrase: '15–30 days', hash: '#within-30', upTo: 30 },
  { key: 'w31', label: 'Over 30 days', phrase: 'more than 30 days', hash: '', upTo: Infinity },
];
export const NO_DATE_WINDOW: DeadlineWindow = { key: 'none', label: 'No date', phrase: 'no closing date', hash: '', upTo: NaN };

/** Index into DEADLINE_WINDOWS for a closing date, or -1 when there is none. */
export function windowIndex(closesOn: string | null, todayIso: string): number {
  if (!closesOn) return -1;
  const d = daysBetween(todayIso, closesOn);
  return DEADLINE_WINDOWS.findIndex((w) => d <= w.upTo);
}

export interface GridRow {
  /** Category letter, or null for the rolled-up "Other categories" row. */
  letter: string | null;
  name: string;
  /** One count per column of the model. */
  counts: number[];
  total: number;
  /** Number of categories behind a rolled-up row (1 for a normal row). */
  categories: number;
}
export interface DeadlineGridModel {
  columns: DeadlineWindow[];
  rows: GridRow[];
  /** Largest single cell, the shading reference. */
  max: number;
  total: number;
}

/**
 * Rows = categories, largest total first (ties by letter); at most `maxRows`
 * rows including the "Other categories" roll-up of the tail. A "No date"
 * column exists only when some notice lacks a closing date. null below the
 * minimum of two categories.
 */
export function deadlineGrid(
  notices: Pick<NoticeLike, 'category' | 'closesOn'>[],
  todayIso: string,
  nameOf: (letter: string) => string,
  maxRows = MAX_GRID_ROWS
): DeadlineGridModel | null {
  const coded = notices.filter((n) => n.category !== 'other');
  const hasNoDate = coded.some((n) => !n.closesOn);
  const columns = hasNoDate ? [...DEADLINE_WINDOWS, NO_DATE_WINDOW] : DEADLINE_WINDOWS;
  const noDateCol = columns.length - 1;
  const byLetter = new Map<string, number[]>();
  for (const n of coded) {
    let counts = byLetter.get(n.category);
    if (!counts) {
      counts = new Array(columns.length).fill(0);
      byLetter.set(n.category, counts);
    }
    const w = windowIndex(n.closesOn, todayIso);
    counts[w === -1 ? noDateCol : w] += 1;
  }
  if (byLetter.size < MIN_CATEGORIES_GRID) return null;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const all: GridRow[] = [...byLetter.entries()]
    .map(([letter, counts]) => ({ letter, name: nameOf(letter), counts, total: sum(counts), categories: 1 }))
    .sort((a, b) => b.total - a.total || (a.letter as string).localeCompare(b.letter as string));
  let rows = all;
  if (all.length > maxRows) {
    const head = all.slice(0, maxRows - 1);
    const tail = all.slice(maxRows - 1);
    const counts = columns.map((_, j) => tail.reduce((s, r) => s + r.counts[j], 0));
    rows = [...head, { letter: null, name: OTHER_CATEGORIES, counts, total: sum(counts), categories: tail.length }];
  }
  return {
    columns,
    rows,
    max: Math.max(0, ...rows.flatMap((r) => r.counts)),
    total: coded.length,
  };
}

// ---------------------------------------------------------------------------
// Set-aside mix
// ---------------------------------------------------------------------------

export interface SetasideRow {
  label: string;
  /** Value the page's Set-aside filter takes; null for the rolled-up row. */
  filterValue: string | null;
  value: number;
  /** Whole-percent share of all notices; '<1%' when it rounds to zero. */
  share: string;
  kind: 'none' | 'main' | 'other';
  /** Number of distinct set-aside values behind a rolled-up row. */
  types: number;
}
export interface SetasideModel {
  rows: SetasideRow[];
  total: number;
}

export function shareLabel(v: number, total: number): string {
  if (!(total > 0) || !(v > 0)) return '0%';
  const p = Math.round((v / total) * 100);
  return p === 0 ? '<1%' : `${p}%`;
}

/**
 * "No set-aside" first (when any), then the other values by count; at most
 * `maxRows` rows including an "Other set-asides" roll-up. null with fewer
 * than two distinct values (no set-aside counts as one).
 */
export function setasideMix(notices: Pick<NoticeLike, 'setaside'>[], maxRows = MAX_SETASIDE_ROWS): SetasideModel | null {
  const counts = new Map<string, number>();
  let none = 0;
  for (const n of notices) {
    if (n.setaside === null) none += 1;
    else counts.set(n.setaside, (counts.get(n.setaside) ?? 0) + 1);
  }
  const total = notices.length;
  const distinct = counts.size + (none > 0 ? 1 : 0);
  if (distinct < MIN_SETASIDE_VALUES) return null;
  const others = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows: SetasideRow[] = [];
  if (none > 0) rows.push({ label: NO_SETASIDE, filterValue: FILTER_NONE, value: none, share: shareLabel(none, total), kind: 'none', types: 1 });
  const room = maxRows - rows.length;
  const shown = others.length > room ? others.slice(0, room - 1) : others;
  for (const [label, value] of shown) rows.push({ label, filterValue: label, value, share: shareLabel(value, total), kind: 'main', types: 1 });
  const rest = others.slice(shown.length);
  if (rest.length > 0) {
    const value = rest.reduce((s, [, v]) => s + v, 0);
    rows.push({ label: OTHER_SETASIDES, filterValue: null, value, share: shareLabel(value, total), kind: 'other', types: rest.length });
  }
  return { rows, total };
}

/** Drops the trailing "(FAR 19.5)" citation so labels fit; the tooltip keeps the full text. */
export function shortSetaside(label: string): string {
  const s = label.replace(/\s*\(FAR[^)]*\)\s*$/i, '').trim();
  return s === '' ? label : s;
}

/** Greedy word wrap into at most `maxLines` lines; the last line gets an ellipsis when cut. */
export function wrapLabel(s: string, maxChars: number, maxLines = 2): string[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    const next = cur === '' ? w : `${cur} ${w}`;
    if (next.length <= maxChars || cur === '') {
      cur = next;
    } else {
      if (lines.length === maxLines - 1) break;
      lines.push(cur);
      cur = w;
    }
  }
  const cut = i < words.length;
  const last = cut ? `${cur} ${words.slice(i).join(' ')}` : cur;
  lines.push(last.length > maxChars ? `${last.slice(0, maxChars - 1).trimEnd()}…` : last);
  return lines;
}

// ---------------------------------------------------------------------------
// Where the work is
// ---------------------------------------------------------------------------

const TILE_CODES = new Set(STATE_TILES.map((t) => t[0]));

/** Upper-cased 2-letter code that has a tile (50 states + DC); anything else is null. */
export function normalizeState(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) && TILE_CODES.has(s) ? s : null;
}

export interface StateModel {
  counts: Map<string, number>;
  max: number;
  /** Notices that landed on a tile. */
  placed: number;
  /** Notices with no usable place of performance. */
  unplaced: number;
}

/** null below the minimum of five notices with a usable state. */
export function stateModel(notices: Pick<NoticeLike, 'state'>[]): StateModel | null {
  const counts = new Map<string, number>();
  let placed = 0;
  for (const n of notices) {
    const st = normalizeState(n.state);
    if (!st) continue;
    counts.set(st, (counts.get(st) ?? 0) + 1);
    placed += 1;
  }
  if (placed < MIN_NOTICES_WITH_STATE) return null;
  return { counts, max: Math.max(...counts.values()), placed, unplaced: notices.length - placed };
}

export const noPlaceNote = (n: number): string | undefined =>
  n > 0 ? `${n.toLocaleString('en-US')} ${n === 1 ? 'notice gives' : 'notices give'} no place of performance.` : undefined;
