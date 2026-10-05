// scripts/embed.ts — the "Embed" control on a chart: the button toggles the
// snippet block (aria-expanded kept in sync), "Copy" puts the snippet on the
// clipboard (falling back to selecting the text) and reads "Copied" for 1.5s.
// Buttons are native <button>s, so Enter and Space work without extra code.

function selectText(node: Element): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function flash(btn: HTMLButtonElement, label: string): void {
  const prev = btn.dataset.label ?? btn.textContent ?? 'Copy';
  btn.dataset.label = prev;
  btn.textContent = label;
  window.setTimeout(() => {
    btn.textContent = prev;
  }, 1500);
}

document.addEventListener('click', async (e) => {
  const from = e.target instanceof Element ? e.target : null;
  const toggle = from?.closest<HTMLButtonElement>('[data-embed-toggle]');
  if (toggle) {
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!panel) return;
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    return;
  }
  const copy = from?.closest<HTMLButtonElement>('[data-embed-copy]');
  if (!copy) return;
  const pre = document.getElementById(copy.getAttribute('data-embed-copy') ?? '');
  if (!pre) return;
  const text = pre.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    flash(copy, 'Copied');
  } catch {
    // No clipboard permission (or an insecure page): select the text so Ctrl/Cmd+C works.
    selectText(pre);
    try {
      flash(copy, document.execCommand('copy') ? 'Copied' : 'Press Ctrl+C');
    } catch {
      flash(copy, 'Press Ctrl+C');
    }
  }
});
