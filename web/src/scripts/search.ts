// Vanilla-TS home search box: accepts a 13-digit NSN (dashed or not), a
// 9-digit NIIN, or a manufacturer part number, asks /api/lookup.json (a
// request-time endpoint backed by the catalog database) and navigates to the
// canonical /nsn/<dashed>/ page.

interface LookupResult {
  ok: boolean;
  kind: 'nsn' | 'niin' | 'part_number' | 'invalid';
  matches: string[];
  error?: string;
}

function toDashed(nsn13: string): string {
  return `${nsn13.slice(0, 4)}-${nsn13.slice(4, 6)}-${nsn13.slice(6, 9)}-${nsn13.slice(9, 13)}`;
}

function setMessage(el: HTMLElement, text: string, state: 'idle' | 'error' | 'info'): void {
  el.textContent = text;
  el.dataset.state = state;
}

function setMatches(el: HTMLElement, label: string, dashed: string[]): void {
  el.textContent = '';
  el.dataset.state = 'info';
  el.append(`${label} `);
  dashed.slice(0, 6).forEach((d, i) => {
    if (i > 0) el.append(' · ');
    const a = document.createElement('a');
    a.href = `/nsn/${d}/`;
    a.textContent = d;
    el.append(a);
  });
}

function init(): void {
  const form = document.querySelector<HTMLFormElement>('[data-search-form]');
  const input = document.querySelector<HTMLInputElement>('[data-search-input]');
  const message = document.querySelector<HTMLElement>('[data-search-message]');
  if (!form || !input || !message) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const digits = raw.replace(/[^0-9]/g, '');

    setMessage(message, 'Looking that up…', 'idle');

    try {
      const res = await fetch(`/api/lookup.json?q=${encodeURIComponent(raw)}`);
      const result = (await res.json()) as LookupResult;

      if (!result.ok) {
        setMessage(message, result.error ?? 'Search is temporarily unavailable. Please try again shortly.', 'error');
        return;
      }
      if (result.matches.length === 1) {
        window.location.href = `/nsn/${result.matches[0]}/`;
        return;
      }
      if (result.matches.length > 1) {
        setMatches(message, `Part number ${raw.toUpperCase()} maps to several NSNs:`, result.matches);
        return;
      }
      if (result.kind === 'part_number') {
        setMessage(message, `No indexed NSN references part number "${raw}" yet.`, 'error');
      } else {
        setMessage(
          message,
          `${digits.length === 13 ? `NSN ${toDashed(digits)}` : `NIIN ${digits}`} is not in the catalog yet.`,
          'error'
        );
      }
    } catch {
      setMessage(message, 'Search is temporarily unavailable. Please try again shortly.', 'error');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
