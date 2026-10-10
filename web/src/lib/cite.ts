// cite.ts — wording of the "Cite this page" block (components/CiteThis.astro).
// Pure and dependency-free: the component builds the server-rendered text with
// it and its script builds the "Accessed" sentence in the browser.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-10-04" (or a longer ISO timestamp) -> "October 4, 2026"; '' if it is not a date. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : '';
}

/** The viewer's own calendar date as "October 4, 2026". */
export function longDateOf(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Everything up to and including "Data as of ...". The Accessed sentence is added in the browser. */
export function citationBase(title: string, url: string, asOf: string): string {
  const quoted = /[.?!]$/.test(title) ? `"${title}"` : `"${title}."`;
  const as = longDate(asOf);
  return `NSN Explorer. ${quoted} nsnexplorer.com, ${url}.${as ? ` Data as of ${as}.` : ''}`;
}

export function accessedSentence(d: Date): string {
  return ` Accessed ${longDateOf(d)}.`;
}
