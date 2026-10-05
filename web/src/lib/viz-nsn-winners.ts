// viz-nsn-winners.ts — chart 17: who wins this item. Rows are suppliers with
// awards (most recent first), then listed sources that have no award yet.
import { monthYear } from './viz.ts';
import { isoMs, plural, supplierLabel } from './viz-nsn-common.ts';

export const MAX_ROWS = 8;
export const MAX_DOTS = 12;
export const RECENT_MONTHS = 24;

export interface WinAward {
  date: string;
  cage: string | null;
  name: string | null;
}
export interface Source {
  cage: string;
  name: string | null;
}

export interface WinnerRow {
  cage: string;
  name: string;
  lastAward: string | null;
  recent: number;
  older: number;
  listed: boolean;
  /** Dots drawn: recent first, then older, capped at 12; `more` is the remainder shown as "+N". */
  dotsRecent: number;
  dotsOld: number;
  more: number;
  ariaLabel: string;
}

export interface WinnersModel {
  rows: WinnerRow[];
  /** False when the part-number table lists no CAGE at all: then "Not listed" would assert nothing we know. */
  haveSources: boolean;
  note: string;
}

export function cutoff(todayIso: string, months = RECENT_MONTHS): string {
  const d = new Date(isoMs(todayIso));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function awardsLabel(recent: number, older: number): string {
  if (recent > 0 && older > 0) return `${recent} recent and ${older} older awards`;
  if (recent > 0) return `${recent} recent ${plural(recent, 'award')}`;
  if (older > 0) return `${older} older ${plural(older, 'award')}`;
  return 'no awards on record';
}

export function buildWinners(awards: WinAward[], sources: Source[], todayIso: string): WinnersModel | null {
  if (awards.length < 1) return null;
  const since = cutoff(todayIso);
  const listed = new Map<string, Source>();
  for (const s of sources) if (s.cage && !listed.has(s.cage.trim())) listed.set(s.cage.trim(), s);

  interface Acc {
    cage: string;
    name: string | null;
    last: string;
    recent: number;
    older: number;
  }
  const byCage = new Map<string, Acc>();
  for (const a of [...awards].sort((p, q) => q.date.localeCompare(p.date))) {
    if (!a.cage) continue;
    const cage = a.cage.trim();
    const cur = byCage.get(cage) ?? { cage, name: null, last: a.date, recent: 0, older: 0 };
    cur.name ||= a.name?.trim() || null;
    if (a.date >= since) cur.recent++;
    else cur.older++;
    byCage.set(cage, cur);
  }
  const won = [...byCage.values()].sort((p, q) => q.last.localeCompare(p.last) || p.cage.localeCompare(q.cage));
  const unawarded = [...listed.values()]
    .filter((s) => !byCage.has(s.cage.trim()))
    .map((s) => ({ cage: s.cage.trim(), name: s.name?.trim() || null }))
    .sort((p, q) => (supplierLabel(p.name, p.cage) ?? '').localeCompare(supplierLabel(q.name, q.cage) ?? ''));

  const rows: WinnerRow[] = [
    ...won.map((w) => ({ ...w, name: w.name ?? listed.get(w.cage)?.name?.trim() ?? null })).map((w) => mkRow(w.cage, w.name, w.last, w.recent, w.older, listed.has(w.cage))),
    ...unawarded.map((u) => mkRow(u.cage, u.name, null, 0, 0, true)),
  ].slice(0, MAX_ROWS);

  // "{Top} won K of the last M awards." over the most recent min(10, total) awards.
  const last = [...awards].sort((p, q) => q.date.localeCompare(p.date)).slice(0, 10);
  const tally = new Map<string, { n: number; latest: string }>();
  for (const a of last) {
    if (!a.cage) continue;
    const c = a.cage.trim();
    const t = tally.get(c) ?? { n: 0, latest: a.date };
    t.n++;
    tally.set(c, t);
  }
  let note = '';
  for (const [c, t] of [...tally.entries()].sort((p, q) => q[1].n - p[1].n || q[1].latest.localeCompare(p[1].latest) || p[0].localeCompare(q[0]))) {
    const nm = rows.find((r) => r.cage === c)?.name ?? `CAGE ${c}`;
    note = last.length === 1 ? `${nm} won the only award on record.` : `${nm} won ${t.n} of the last ${last.length} awards.`;
    break;
  }
  if (rows.length === 0) return null;
  const haveSources = listed.size > 0;
  if (haveSources) {
    const unlisted = won.filter((w) => !listed.has(w.cage)).map((w) => rows.find((r) => r.cage === w.cage)?.name ?? `CAGE ${w.cage}`);
    if (unlisted.length === 1) note += ` ${unlisted[0]} won without being a listed source.`;
    else if (unlisted.length > 1) note += ` ${unlisted[0]} and ${unlisted.length - 1} ${plural(unlisted.length - 1, 'other')} won without being listed sources.`;
  }
  return { rows, haveSources, note: note.trim() };
}

function mkRow(cage: string, name: string | null, last: string | null, recent: number, older: number, listed: boolean): WinnerRow {
  const total = recent + older;
  const shown = Math.min(total, MAX_DOTS);
  const dotsRecent = Math.min(recent, shown);
  return {
    cage,
    name: supplierLabel(name, cage)!,
    lastAward: last,
    recent,
    older,
    listed,
    dotsRecent,
    dotsOld: shown - dotsRecent,
    more: total - shown,
    ariaLabel: awardsLabel(recent, older),
  };
}

export const lastAwardText = (iso: string | null): string => (iso ? `last award ${monthYear(iso)}` : 'no award yet');
