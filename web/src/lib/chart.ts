// Pure geometry helpers for the hand-rolled price-history SVG chart.
// No chart library; see docs/chart-spec.md.

function niceNumber(range: number, round: boolean): number {
  if (range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

/** 3-5 clean-dollar ticks starting at 0, linear. */
export function niceTicks(maxValue: number, targetCount = 4): number[] {
  if (!(maxValue > 0)) return [0, 1];
  const niceRange = niceNumber(maxValue, false);
  const step = niceNumber(niceRange / Math.max(targetCount - 1, 1), true);
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

export function formatTickDollar(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export interface XTick {
  time: number; // epoch ms
  label: string;
}

/** Years when span >= 2 years, otherwise months. */
export function computeXTicks(dates: Date[]): XTick[] {
  if (dates.length === 0) return [];
  const min = new Date(Math.min(...dates.map((d) => d.getTime())));
  const max = new Date(Math.max(...dates.map((d) => d.getTime())));
  const spanDays = (max.getTime() - min.getTime()) / 86400000;

  let ticks: XTick[];
  if (spanDays < 730) {
    ticks = [];
    let cur = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1));
    const end = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth(), 1));
    while (cur.getTime() <= end.getTime()) {
      ticks.push({
        time: cur.getTime(),
        label: new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(cur),
      });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  } else {
    ticks = [];
    for (let y = min.getUTCFullYear(); y <= max.getUTCFullYear(); y++) {
      ticks.push({ time: Date.UTC(y, 0, 1), label: String(y) });
    }
  }

  if (ticks.length > 7) {
    const step = Math.ceil(ticks.length / 6);
    ticks = ticks.filter((_, i) => i % step === 0);
  }
  return ticks;
}
