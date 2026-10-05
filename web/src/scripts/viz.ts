// scripts/viz.ts — the only client code the charts share.
//  1. Tooltips: any element with data-tip shows it on hover or keyboard
//     focus. The text is set with textContent (first line bold), never
//     innerHTML, because tips carry government-supplied strings.
//  2. Segmented toggles: a .viz-seg whose buttons carry data-seg-show="id"
//     shows that panel and hides its siblings (panels share data-seg-group).
// Charts that need more than this (the award calculator, the compare tool)
// bring their own small script.

let tipEl: HTMLDivElement | null = null;

function ensureTip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'viz-tip';
    tipEl.setAttribute('role', 'status');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function fill(el: HTMLDivElement, raw: string): void {
  el.textContent = '';
  const [first, ...rest] = raw.split('\n');
  const b = document.createElement('b');
  b.textContent = first;
  el.appendChild(b);
  if (rest.length) el.appendChild(document.createTextNode(rest.join('\n')));
}

function place(el: HTMLDivElement, x: number, y: number): void {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = x + 14;
  let top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function target(e: Event): Element | null {
  return e.target instanceof Element ? e.target.closest('[data-tip]') : null;
}

document.addEventListener('mousemove', (e) => {
  const t = target(e);
  const el = ensureTip();
  if (!t) {
    el.style.opacity = '0';
    return;
  }
  fill(el, t.getAttribute('data-tip') ?? '');
  el.style.opacity = '1';
  place(el, e.clientX, e.clientY);
});
document.addEventListener('focusin', (e) => {
  const t = target(e);
  if (!t) return;
  const el = ensureTip();
  fill(el, t.getAttribute('data-tip') ?? '');
  el.style.opacity = '1';
  const r = t.getBoundingClientRect();
  place(el, r.left + r.width / 2, r.top);
});
document.addEventListener('focusout', () => {
  if (tipEl) tipEl.style.opacity = '0';
});
document.addEventListener('scroll', () => {
  if (tipEl) tipEl.style.opacity = '0';
}, { passive: true });

document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('.viz-seg button[data-seg-show]') : null;
  if (!btn) return;
  const seg = btn.closest('.viz-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
  const show = btn.getAttribute('data-seg-show');
  const group = seg.getAttribute('data-seg-group');
  document.querySelectorAll<HTMLElement>(`[data-seg-panel="${group}"]`).forEach((p) => {
    p.hidden = p.id !== show;
  });
});
