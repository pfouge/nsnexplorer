// scripts/freshness.ts — fills every .viz-fresh strip on the page from
// /data/freshness.json using the viewer's clock. The wrapper is visible from the first paint (empty
// cells hold the space); if the fetch fails it is hidden.
import { freshnessView, type FreshnessSource } from '../lib/viz-site.ts';

function fill(cell: HTMLElement, src: FreshnessSource, nowMs: number): boolean {
  const view = freshnessView(src.lastLanded, src.limitHours, nowMs);
  if (!view) return false;
  cell.classList.toggle('late', view.late);
  const set = (sel: string, text: string) => {
    const el = cell.querySelector(sel);
    if (el) el.textContent = text;
  };
  set('.n', `${view.symbol} ${src.label}`);
  set('.a', view.age);
  set('.s', src.cadence);
  const meter = cell.querySelector<HTMLElement>('.m');
  const bar = cell.querySelector<HTMLElement>('.m i');
  if (meter) meter.setAttribute('aria-label', view.meterLabel);
  if (bar) bar.style.width = `${view.widthPct}%`;
  return true;
}

async function load(): Promise<void> {
  const scopes = document.querySelectorAll<HTMLElement>('[data-fresh-scope]');
  if (scopes.length === 0) return;
  try {
    const res = await fetch('/data/freshness.json');
    if (!res.ok) return hideAll(scopes);
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return hideAll(scopes);
    const sources = raw as FreshnessSource[];
    const nowMs = Date.now();
    for (const scope of scopes) {
      let shown = 0;
      scope.querySelectorAll<HTMLElement>('[data-fresh]').forEach((cell) => {
        const src = sources.find((s) => s.key === cell.dataset.fresh);
        if (src && fill(cell, src, nowMs)) shown += 1;
        else cell.remove();
      });
      scope.hidden = shown === 0;
    }
  } catch {
    hideAll(scopes);
  }
}

// The strip is shown from the first paint with its cells empty, so filling it moves nothing.
// Only a failed load removes it.
function hideAll(scopes: NodeListOf<HTMLElement>): void {
  scopes.forEach((s) => { s.hidden = true; });
}

void load();
