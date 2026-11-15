// scripts/hidden-classes.ts — client for /open/. Reads the visitor's hidden
// class list from localStorage and hides matching [data-fsc] elements (class
// tiles and table rows). Every storage access is guarded: without localStorage
// the page works, the buttons just last until reload. Labels are written with
// textContent only.
import { HIDDEN_CLASSES_KEY, parseHidden, serialiseHidden, toggleHidden, visibleCount } from '../lib/hidden-classes';

let hidden: string[] = [];
try {
  hidden = parseHidden(localStorage.getItem(HIDDEN_CLASSES_KEY));
} catch {
  hidden = [];
}

const section = document.getElementById('categories');
const chooseBtn = document.getElementById('hc-choose') as HTMLButtonElement | null;
const statusEl = document.getElementById('hc-status');
const introEl = document.getElementById('hc-intro');
const noteEl = document.getElementById('hc-note');
let editing = false;
const countEl = document.getElementById('hc-count');
const manage = document.getElementById('hc-manage');
const manageBtn = document.getElementById('hc-manage-btn') as HTMLButtonElement | null;
const showAll = document.getElementById('hc-showall') as HTMLButtonElement | null;
const listEl = document.getElementById('hc-list');

const names = new Map<string, string>();
document.querySelectorAll<HTMLElement>('[data-fsc][data-fsc-name]').forEach((el) => {
  if (el.dataset.fsc && el.dataset.fscName) names.set(el.dataset.fsc, el.dataset.fscName);
});
const label = (code: string) => (names.has(code) ? `${code} ${names.get(code)}` : code);

function save() {
  try {
    if (hidden.length) localStorage.setItem(HIDDEN_CLASSES_KEY, serialiseHidden(hidden));
    else localStorage.removeItem(HIDDEN_CLASSES_KEY);
  } catch {
    /* private mode or storage blocked: the change still applies to this page view */
  }
}

function render() {
  const set = new Set(hidden);
  document.querySelectorAll<HTMLElement>('[data-fsc]').forEach((el) => {
    el.hidden = set.has(el.dataset.fsc ?? '');
  });
  // A department block, and its jump chip, goes when every class in it is hidden.
  document.querySelectorAll<HTMLElement>('[data-fscs]').forEach((el) => {
    const codes = (el.dataset.fscs ?? '').split(' ').filter(Boolean);
    el.hidden = codes.length > 0 && codes.every((c) => set.has(c));
  });
  const closing = document.getElementById('hc-closing-count');
  if (closing) {
    const codes = [...document.querySelectorAll<HTMLElement>('#closing tbody tr')].map((r) => r.dataset.fsc ?? null);
    closing.textContent = String(visibleCount(codes, hidden));
  }
  document.querySelectorAll<HTMLElement>('[data-hide]').forEach((b) => {
    b.hidden = !editing;
  });
  if (section) {
    if (editing) section.setAttribute('data-hc-edit', '');
    else section.removeAttribute('data-hc-edit');
  }
  if (chooseBtn) {
    chooseBtn.textContent = editing ? 'Done' : 'Choose classes';
    chooseBtn.setAttribute('aria-pressed', String(editing));
  }
  if (introEl) introEl.hidden = hidden.length > 0;
  if (statusEl) statusEl.hidden = hidden.length === 0;
  if (noteEl) noteEl.hidden = hidden.length === 0;
  if (countEl) {
    countEl.textContent = `${hidden.length} ${hidden.length === 1 ? 'class' : 'classes'} hidden`;
  }
  if (hidden.length === 0 && manage && manageBtn) {
    manage.hidden = true;
    manageBtn.setAttribute('aria-expanded', 'false');
  }
  if (listEl) {
    listEl.textContent = '';
    for (const code of hidden) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = label(code);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost';
      b.dataset.show = code;
      b.textContent = 'Show';
      b.setAttribute('aria-label', `Show class ${label(code)}`);
      li.append(span, b);
      listEl.append(li);
    }
  }
}

document.addEventListener('click', (e) => {
  const t = e.target as Element | null;
  const hide = t?.closest<HTMLElement>('[data-hide]');
  const show = t?.closest<HTMLElement>('[data-show]');
  if (hide?.dataset.hide) {
    hidden = toggleHidden(hidden, hide.dataset.hide);
  } else if (show?.dataset.show) {
    hidden = hidden.filter((c) => c !== show.dataset.show);
  } else {
    return;
  }
  save();
  render();
});

chooseBtn?.addEventListener('click', () => {
  editing = !editing;
  render();
});

showAll?.addEventListener('click', () => {
  hidden = [];
  save();
  render();
});

manageBtn?.addEventListener('click', () => {
  if (!manage) return;
  manage.hidden = !manage.hidden;
  manageBtn.setAttribute('aria-expanded', String(!manage.hidden));
});

render();
