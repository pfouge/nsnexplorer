// Runs the email signup forms (components/SignupForm.astro) without leaving the page: sends the
// form to /api/signup, then shows the answer inside the form. Where the form carries a Turnstile
// site key, Cloudflare's bot check is loaded the first time the visitor touches the email field
// (not on every page view) and its token is sent along; the widget stays invisible unless
// Cloudflare decides it needs a click. Without JavaScript the form posts normally.

type Turnstile = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
};

const API_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN_WAIT_MS = 20000;

let api: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  api ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = API_URL;
    s.async = true;
    s.onload = () => {
      const t = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (t) resolve(t); else reject(new Error('turnstile missing'));
    };
    s.onerror = () => { api = null; reject(new Error('turnstile blocked')); };
    document.head.append(s);
  });
  return api;
}

function setUp(form: HTMLFormElement): void {
  const email = form.querySelector<HTMLInputElement>('input[type="email"]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = form.querySelector<HTMLElement>('[data-signup-status]');
  const box = form.querySelector<HTMLElement>('[data-signup-check]');
  if (!email || !button || !status) return;
  const siteKey = form.dataset.sitekey ?? '';

  let widget: string | null = null;
  let token = '';
  let waiting: ((t: string) => void)[] = [];
  const settle = (t: string) => { token = t; for (const w of waiting.splice(0)) w(t); };

  const say = (text: string, kind: 'info' | 'error' = 'info') => {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = false;
  };

  async function ensureWidget(): Promise<void> {
    if (!siteKey || !box || widget !== null) return;
    const ts = await loadTurnstile();
    if (widget !== null) return;
    box.hidden = false;
    widget = ts.render(box, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      size: 'flexible',
      callback: (t: string) => settle(t),
      'expired-callback': () => { token = ''; },
      'error-callback': () => { settle(''); return true; },
    });
  }

  const tokenOrWait = (): Promise<string> =>
    token ? Promise.resolve(token) : new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), TOKEN_WAIT_MS);
      waiting.push((t) => { clearTimeout(timer); resolve(t); });
    });

  const warmUp = () => { void ensureWidget().catch(() => {}); };
  email.addEventListener('focus', warmUp, { once: true });
  email.addEventListener('input', warmUp, { once: true });

  let busy = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || form.dataset.done !== undefined) return;
    if (!form.reportValidity()) return;
    busy = true;
    button.disabled = true;
    say('Sending…');
    try {
      let check = '';
      if (siteKey) {
        try { await ensureWidget(); check = await tokenOrWait(); } catch { check = ''; }
        if (!check) {
          say('We could not run the check that tells people from automated programs. Reload the page and try again.', 'error');
          return;
        }
      }
      const data = new FormData(form);
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          email: data.get('email'), hook: data.get('hook'), fsc_interest: data.get('fsc_interest') ?? undefined, turnstile: check || undefined,
        }),
      });
      let body: { ok?: boolean; error?: string } = {};
      try { body = await res.json(); } catch { /* not JSON */ }
      if (res.ok && body.ok) {
        form.dataset.done = '';
        say('Thanks. You are on the list.');
        return;
      }
      say(res.status === 429 ? 'Too many tries in a short time. Wait a few seconds and try again.' : body.error || 'Something went wrong. Please try again.', 'error');
      token = '';
      if (widget !== null) { try { (await loadTurnstile()).reset(widget); } catch { /* keep going */ } }
    } catch {
      say('Something went wrong. Please try again.', 'error');
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-signup]')) setUp(form);
