// scripts/bid-calc.ts — client for the bid calculator. All arithmetic is lib/bid-calc.ts; this file only reads the
// inputs, writes text with textContent, and keeps the margin and price fields mutually exclusive. Nothing is stored or sent.
import { adjustForTime, compare, parseMoney, parsePercent, quote, wholeMonths } from '../lib/bid-calc';
import { formatDate, formatUsdPrecise } from '../lib/shared';

const usd = (n: number | null): string => (n === null ? '—' : formatUsdPrecise(n));
// The visitor's own figures are money they would quote or bank: always cents, never the 4-decimal record precision.
const cents = (n: number | null): string =>
  n === null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null): string => (n === null ? '—' : `${(Math.round(n * 10) / 10).toLocaleString('en-US')}%`);
const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const WORDS = ['', 'one', 'two', 'three', 'four', 'five'];
const lastN = (n: number | null): string => (n === 1 ? 'award' : `${WORDS[n ?? 5] ?? 'five'} awards`);
const side = (p: number): string => (p === 0 ? 'the same as' : `${pct(Math.abs(p))} ${p > 0 ? 'above' : 'below'}`);

function init(root: HTMLElement): void {
  const f = (k: string): HTMLInputElement | null => root.querySelector<HTMLInputElement>(`input[data-bc="${k}"]`);
  const out = (k: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-bc-out="${k}"]`);
  const qty = f('qty');
  const cost = f('cost');
  const other = f('other');
  const margin = f('margin');
  const price = f('price');
  const rate = f('rate');
  if (!qty || !cost || !margin || !price) return;
  const set = (k: string, text: string): void => {
    const el = out(k);
    if (el) el.textContent = text;
  };
  const line = (k: string, text: string | null): void => {
    const el = out(k);
    if (!el) return;
    el.textContent = text ?? '';
    el.hidden = text === null;
  };

  const d = root.dataset;
  const latest = num(d.latest);
  const low = num(d.low);
  const high = num(d.high);
  const average = num(d.average);
  const n = num(d.n);
  const summary = latest !== null && low !== null && high !== null && average !== null ? { latest, low, high, average } : null;

  const update = (): void => {
    const q = quote({
      unitCost: parseMoney(cost.value),
      marginPct: parsePercent(margin.value),
      unitPrice: parseMoney(price.value),
      quantity: parseMoney(qty.value),
      otherCostPerOrder: other && other.value.trim() !== '' ? parseMoney(other.value) ?? NaN : 0,
    });
    set('price', cents(q.unitPrice));
    set('margin', pct(q.marginPct));
    set('profitUnit', cents(q.profitPerUnit));
    set('total', cents(q.total));
    set('profitTotal', cents(q.profitTotal));

    if (!summary) return;
    const c = compare(q.unitPrice, summary);
    if (c.vsLatestPct === null || c.vsAveragePct === null) {
      line('vsLatest', null);
    } else {
      line('vsLatest', `Your price is ${side(c.vsLatestPct)} the last award and ${side(c.vsAveragePct)} the average of the last ${lastN(n)}.`);
    }
    const rangeName = n === 1 ? 'single-award' : `last-${WORDS[n ?? 5] ?? 'five'}`;
    const r = `${usd(summary.low)} – ${usd(summary.high)}`;
    line(
      'range',
      c.position === null
        ? null
        : c.position === 'in_range'
          ? `Within the ${rangeName} range (${r}).`
          : c.position === 'above_range'
            ? `Above the ${rangeName} range (${r}).`
            : `Below the ${rangeName} range (${r}).`
    );
    const annual = rate ? parsePercent(rate.value) : null;
    const on = d.latestOn;
    if (annual === null || !on) {
      line('carried', null);
    } else {
      const adj = adjustForTime(summary.latest, on, todayIso(), annual);
      const months = wholeMonths(on, todayIso());
      line('carried', adj === null ? null : `Last price carried forward at ${pct(annual)} a year: ${cents(adj)} (${months} whole month${months === 1 ? '' : 's'} since ${formatDate(on)}).`);
    }
  };

  // Editing the margin clears the price and the other way round.
  margin.addEventListener('input', () => {
    if (margin.value.trim() !== '') price.value = '';
  });
  price.addEventListener('input', () => {
    if (price.value.trim() !== '') margin.value = '';
  });
  for (const el of root.querySelectorAll<HTMLInputElement>('input[data-bc]')) el.addEventListener('input', update);
  // Enter in a field must never submit anything.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  update();
}

document.querySelectorAll<HTMLElement>('[data-bid-calc]').forEach(init);
