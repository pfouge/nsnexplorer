// What a watchlist says about its items, as plain sentences: feed events, card headlines and the
// CSV download. Pure (no DOM, no network) so the page scripts and the unit tests share it.
//
// The site "offers no recommendations": every sentence here only restates a record (a date, a
// quantity, a price, a code) or a difference between two records. No ranking, no advice.

import { COMPETITION_BADGE, competitionOf, formatDate, formatUsd, formatUsdPrecise, toDashedNsn } from './shared.ts';
import { toCsv, type CsvCell } from './csv.ts';
import { itemPath, KIND_LABEL, type Item, type Kind } from './account.ts';

// ── feed ───────────────────────────────────────────────────────────────────────────────────
export type EventType = 'rfq' | 'award' | 'contract_action' | 'changed';
export interface FeedEvent {
  type: EventType; at: string; url?: string | null;
  sol?: string; nsn?: string; item?: string | null; issued_on?: string | null; return_by?: string | null; quantity?: number | null;
  status?: string; source?: string; awarded_on?: string; unit_price?: number; cage?: string | null; supplier?: string | null;
  action_date?: string | null; obligation?: number | null; description?: string | null; agency?: string | null; recipient?: string | null; piid?: string | null;
  was_status?: string | null; was_return_by?: string | null; was_quantity?: number | null;
}
export interface FeedItem { list: string; kind: Kind; key: string; label: string | null; since: string; count: number; events: FeedEvent[] }
export interface Feed { changed: number; items: FeedItem[] }

const date = (d: string | null | undefined): string => (d ? formatDate(d.slice(0, 10)) : 'date not given');
const num = (n: number): string => n.toLocaleString('en-US');
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const EVENT_LABEL: Record<EventType, string> = {
  rfq: 'New solicitation', award: 'Award recorded', contract_action: 'Contract action', changed: 'Changed',
};

/** One event as a sentence. `kind` is the followed item's kind (it decides what is already obvious). */
export function eventText(kind: Kind, e: FeedEvent): string {
  const nsnPart = kind !== 'nsn' && e.nsn ? ` NSN ${toDashedNsn(e.nsn)}` : '';
  const itemPart = e.item ? ` ${clip(e.item, 60)}` : '';
  switch (e.type) {
    case 'rfq': {
      const bits = [`Solicitation ${e.sol} added`];
      if (e.item || nsnPart) bits.push(`for${itemPart}${nsnPart ? (e.item ? ',' : '') + nsnPart : ''}`);
      const tail = [e.quantity != null ? `quantity ${num(e.quantity)}` : '', `return by ${date(e.return_by)}`].filter(Boolean).join(', ');
      return `${bits.join(' ')}. ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.`;
    }
    case 'award': {
      const who = e.supplier ? `${e.supplier}${e.cage ? ` (CAGE ${e.cage})` : ''}` : e.cage ? `CAGE ${e.cage}` : 'supplier not named';
      const what = [itemPart.trim(), nsnPart.trim()].filter(Boolean).join(', ');
      // On a followed supplier the winner is the supplier itself, so it is not repeated.
      const winner = kind === 'supplier' ? '' : `, ${who}`;
      return `Awarded ${date(e.awarded_on)}${what ? ` for ${what}` : ''}: ${e.unit_price != null ? formatUsdPrecise(Number(e.unit_price)) : 'price not given'} each${e.quantity != null ? `, quantity ${num(e.quantity)}` : ''}${winner}.`;
    }
    case 'contract_action': {
      const amount = e.obligation != null ? formatUsd(Number(e.obligation)) : 'amount not given';
      const parts = [`Dated ${date(e.action_date)}: ${amount}`];
      if (e.recipient) parts.push(`to ${e.recipient}`);
      if (e.agency) parts.push(`from ${e.agency}`);
      const s = e.description ? `${parts.join(' ')}. ${clip(e.description, 90)}` : parts.join(' ');
      return s.endsWith('.') || s.endsWith('…') ? s : `${s}.`;
    }
    case 'changed': {
      const out: string[] = [];
      if (e.status != null && e.status !== e.was_status) out.push(`status changed from ${e.was_status ?? 'unknown'} to ${e.status}`);
      if ((e.return_by ?? null) !== (e.was_return_by ?? null)) out.push(`return-by changed from ${e.was_return_by ? date(e.was_return_by) : 'none'} to ${e.return_by ? date(e.return_by) : 'none'}`);
      if (Number(e.quantity ?? NaN) !== Number(e.was_quantity ?? NaN) && (e.quantity != null || e.was_quantity != null)) out.push(`quantity changed from ${e.was_quantity != null ? num(Number(e.was_quantity)) : 'none'} to ${e.quantity != null ? num(Number(e.quantity)) : 'none'}`);
      const s = out.join('; ');
      return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : 'Record updated.';
    }
  }
}

/** "3 changes" / "100 or more changes". */
export const changeCount = (n: number): string => (n >= 100 ? '100 or more changes' : `${n} ${n === 1 ? 'change' : 'changes'}`);

// ── cards ──────────────────────────────────────────────────────────────────────────────────
// The shapes watch_cards() returns, per kind (db/migrations/0009).
export interface NsnCard { name: string | null; fsc: string; fsc_name: string | null; amc: string | null; amsc: string | null; award_count: number; prices: [string, number][]; latest: { date: string; unit_price: number; quantity: number | null; cage: string | null; supplier: string | null; url: string } | null; open_rfqs: number; next_return_by: string | null }
export interface SupplierCard { name: string | null; city: string | null; state: string | null; country: string | null; award_count: number; months: [string, number, number][]; wins: { date: string; nsn: string; item: string | null; unit_price: number; quantity: number | null; url: string }[] }
export interface ManufacturerCard { name: string | null; part_count: number; nsn_count: number; open_rfqs: number; rfqs: { sol: string; nsn: string; item: string | null; return_by: string | null; quantity: number | null; url: string }[] }
export interface FscCard { name: string; deep?: boolean; has_open?: boolean; open_now: number; posted_7d: number; weeks: [string, number][] }
export interface SolicitationCard { nsn: string | null; item: string | null; quantity: number | null; unit: string | null; issued_on: string | null; return_by: string | null; status: string; source: string; url: string; award: { date: string; unit_price: number; quantity: number | null; cage: string | null; supplier: string | null; url: string } | null }
export interface AgencyCard { name: string; abbreviation: string | null; actions_90d: { count: number; value: number }; awards_90d: { count: number; value: number }; latest: { date: string | null; recipient: string | null; description: string | null; obligation: number | null; url: string }[] }
export interface SearchCard { open_now: number; solicitations: number; new_since: number }
export type AnyCard = NsnCard | SupplierCard | ManufacturerCard | FscCard | SolicitationCard | AgencyCard | SearchCard;
export type Cards = Record<string, AnyCard | undefined>;

const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;

/** Days from `today` (ISO date) to an ISO date; null when no date. */
export function daysUntil(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  return Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** "closes in 5 days", "closes today", "closed 2 days ago". */
export function countdown(iso: string | null | undefined, today: string): string {
  const d = daysUntil(iso, today);
  if (d === null) return 'no return-by date';
  if (d === 0) return 'returns today';
  if (d > 0) return `returns in ${plural(d, 'day')}`;
  return `returned ${plural(-d, 'day')} ago`;
}

/** The kind-specific competition sentence for an NSN card, from its AMC / AMSC. */
export const nsnCoding = (c: Pick<NsnCard, 'amc' | 'amsc'>): string => COMPETITION_BADGE[competitionOf(c.amc, c.amsc)];

/**
 * The page an item links to. A class has /fsc/<fsc>/ only when it is a deep class, and /open/<fsc>/
 * when it has solicitations on record; the card says which. Without a card, the usual path.
 */
export function itemHref(item: Pick<Item, 'kind' | 'key'>, card?: AnyCard): string {
  if (item.kind === 'fsc' && card && (card as FscCard).deep === false) {
    return (card as FscCard).has_open ? `/open/${encodeURIComponent(item.key)}/` : '/catalog/';
  }
  return itemPath(item.kind, item.key);
}

/** Name of an item for display: its label, else the card's own name, else the key. */
export function itemName(i: Pick<Item, 'kind' | 'key' | 'label'>, card?: AnyCard): string {
  if (i.label) return i.label;
  const n = card && 'name' in card ? (card as { name: string | null }).name : null;
  if (n) return n;
  if (i.kind === 'nsn') return toDashedNsn(i.key);
  return i.key;
}

/** One line of headline figures per kind: what the card shows, as text (also the CSV's headline column). */
export function headline(kind: Kind, card: AnyCard | undefined, today: string): string {
  if (!card) return 'No record found for this page.';
  switch (kind) {
    case 'nsn': {
      const c = card as NsnCard;
      const parts: string[] = [];
      if (c.latest) parts.push(`Latest award ${formatUsdPrecise(c.latest.unit_price)} each on ${date(c.latest.date)}${c.latest.supplier ? ` (${c.latest.supplier})` : c.latest.cage ? ` (CAGE ${c.latest.cage})` : ''}`);
      else parts.push('No award on record');
      parts.push(`${plural(c.open_rfqs, 'open RFQ')}${c.next_return_by ? `, soonest return-by ${date(c.next_return_by)}` : ''}`);
      parts.push(nsnCoding(c));
      return parts.join('. ');
    }
    case 'supplier': {
      const c = card as SupplierCard;
      const n12 = c.months.reduce((a, m) => a + m[1], 0), v12 = c.months.reduce((a, m) => a + Number(m[2]), 0);
      return `${plural(n12, 'award')} in the last 12 months${v12 ? `, ${formatUsd(v12)}` : ''}; ${num(c.award_count)} on record${c.wins[0] ? `. Latest ${date(c.wins[0].date)}` : ''}`;
    }
    case 'manufacturer': {
      const c = card as ManufacturerCard;
      return `${plural(c.part_count, 'part number')} on ${plural(c.nsn_count, 'NSN')}; ${plural(c.open_rfqs, 'open RFQ')} on its parts`;
    }
    case 'fsc': {
      const c = card as FscCard;
      return `${num(c.open_now)} open now; ${num(c.posted_7d)} posted in the last 7 days; ${num(c.weeks.reduce((a, w) => a + w[1], 0))} posted in 12 weeks`;
    }
    case 'solicitation': {
      const c = card as SolicitationCard;
      const parts = [`Status ${c.status}`, `${c.quantity != null ? `quantity ${num(c.quantity)}` : 'quantity not given'}`, `issued ${date(c.issued_on)}`, `${c.status === 'open' ? countdown(c.return_by, today) : `return-by ${date(c.return_by)}`}`];
      if (c.award) parts.push(`award ${formatUsdPrecise(c.award.unit_price)} each${c.award.supplier ? ` to ${c.award.supplier}` : c.award.cage ? ` to CAGE ${c.award.cage}` : ''}`);
      return parts.join('; ');
    }
    case 'agency': {
      const c = card as AgencyCard;
      const bits = [`${plural(c.actions_90d.count, 'contract action')} in 90 days${c.actions_90d.value ? ` (${formatUsd(c.actions_90d.value)})` : ''}`];
      if (c.awards_90d.count) bits.push(`${plural(c.awards_90d.count, 'part award')} in 90 days${c.awards_90d.value ? ` (${formatUsd(c.awards_90d.value)})` : ''}`);
      return bits.join('; ');
    }
    case 'search': {
      const c = card as SearchCard;
      return `${plural(c.open_now, 'part')} open now${c.new_since ? `; ${plural(c.new_since, 'new solicitation')} since you last reviewed` : ''}`;
    }
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────────
export const CSV_HEADERS = ['List', 'Type', 'Key', 'Name', 'URL', 'Headline figures', 'Changes since reviewed', 'What changed', 'Last reviewed', 'Added', 'Note'] as const;

export interface CsvInput { list: string; item: Item; card?: AnyCard; feed?: FeedItem }

/** Rows for a list's Download CSV: one per item, from the same data the page shows. */
export function watchCsv(origin: string, rows: CsvInput[], today: string): string {
  const out: CsvCell[][] = rows.map(({ list, item, card, feed }) => [
    list,
    KIND_LABEL[item.kind],
    item.key,
    itemName(item, card),
    `${origin}${itemHref(item, card).replace(/#.*$/, '')}`,
    headline(item.kind, card, today),
    feed ? Math.min(feed.count, 100) : 0,
    feed ? feed.events.map((e) => `${EVENT_LABEL[e.type]}: ${eventText(item.kind, e)}`).join(' | ') : '',
    item.reviewed_at ? item.reviewed_at.slice(0, 10) : '',
    item.added_at ? item.added_at.slice(0, 10) : '',
    item.note ?? '',
  ]);
  return toCsv(CSV_HEADERS, out);
}
