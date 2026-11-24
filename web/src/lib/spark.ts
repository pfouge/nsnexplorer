// Sparkline geometry for key figures (design/system.md, "Sparkline"): 96 x 24, oldest to newest.
// Returns null below two points so a lone value never draws a flat line that looks like a trend.
export interface Spark { d: string; x: number; y: number; w: number; h: number }
export function sparkPath(values: number[], w = 96, h = 24, pad = 2): Spark | null {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = hi - lo || 1;
  const xs = (i: number) => pad + (i * (w - 2 * pad)) / (v.length - 1);
  const ys = (n: number) => (hi === lo ? h / 2 : pad + (h - 2 * pad) * (1 - (n - lo) / span));
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(n).toFixed(1)}`).join('');
  return { d, x: xs(v.length - 1), y: ys(v.at(-1)!), w, h };
}
