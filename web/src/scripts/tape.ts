// scripts/tape.ts — fills the demand tape under the header from
// /data/tape.json. Items are built with DOM methods (textContent only), the
// list is appended twice for a seamless loop (the copy is hidden from
// assistive tech and the tab order), and the tape is unhidden only after a
// successful load with at least 6 items still open at the viewer's date.
import { sourceLabel, tapeItems, tapeStatus, type TapeItem } from '../lib/viz-site.ts';
import { fmtInt } from '../lib/viz.ts';

const root = document.getElementById('demand-tape');

function localIsoDate(d = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function build(item: TapeItem, today: string, copy: boolean): HTMLAnchorElement {
  const status = tapeStatus(item, today);
  const a = document.createElement('a');
  a.href = `/nsn/${item.nsn}/`;
  if (copy) {
    a.setAttribute('aria-hidden', 'true');
    a.tabIndex = -1;
  }
  const em = document.createElement('em');
  em.textContent = `FSC ${item.fsc}`;
  a.append(em, ` · ${item.name}`);
  if (item.quantity !== null) a.append(` · qty ${fmtInt(item.quantity)}`);
  if (status) {
    const b = document.createElement('b');
    b.className = status.cls;
    b.textContent = `● ${status.text}`;
    a.append(' · ', b);
  }
  const small = document.createElement('small');
  small.textContent = sourceLabel(item.source);
  a.append(' · ', small);
  return a;
}

async function load(el: HTMLElement): Promise<void> {
  try {
    const res = await fetch('/data/tape.json');
    if (!res.ok) return;
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return;
    const today = localIsoDate();
    const items = tapeItems(raw as TapeItem[], today);
    if (!items) return;
    const run = document.createElement('div');
    run.className = 'run';
    for (const copy of [false, true]) for (const item of items) run.append(build(item, today, copy));
    el.replaceChildren(run);
    el.hidden = false;
  } catch {
    // Leave the tape hidden: it is an extra, never a dependency.
  }
}

if (root) void load(root);
