// scripts/supplier-board.ts — /supplier/ only. A link such as /supplier/#dollars-all (the rank
// badges on supplier pages) opens the matching sub-list: the panel carries data-seg-panel and
// its toggle button carries data-seg-show (scripts/viz.ts does the toggling on click).
function openFromHash(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const panel = document.getElementById(id);
  if (!panel || !panel.hasAttribute('data-seg-panel')) return;
  const btn = document.querySelector<HTMLButtonElement>(`.viz-seg button[data-seg-show="${CSS.escape(id)}"]`);
  if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
  panel.scrollIntoView();
}
openFromHash();
addEventListener('hashchange', openFromHash);
