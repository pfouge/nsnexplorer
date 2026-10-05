// lib/viz-services.ts — pure number-crunching for the three /services/ charts
// (deadline grid; the set-aside mix and place-of-performance map follow). No pg, no DOM: the
// components in components/viz/ only lay these models out as SVG.
//
// All three count OPEN, CODED service notices (letter category). The uncoded
// 'other' bucket is excluded by the callers and is its own page.

import { daysBetween } from './viz.ts';

export const MIN_CATEGORIES_GRID = 2;
export const MAX_GRID_ROWS = 12;
export const OTHER_CATEGORIES = 'Other categories';

export interface NoticeLike {
  category: string;
  closesOn: string | null;
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
  notices: NoticeLike[],
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
// Label wrapping
// ---------------------------------------------------------------------------

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
