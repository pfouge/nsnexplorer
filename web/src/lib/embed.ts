// embed.ts — pure helpers for the embeddable charts: URLs, the copy-paste
// snippet and the "Updated" date. No DOM, no pg. Imports use explicit .ts
// extensions so `node --test` can load this directly.

export const EMBED_WIDTH = 640;
export const EMBED_HEIGHT = 360;

export interface EmbedInfo {
  /** Absolute URL of the embed page (the iframe src). */
  src: string;
  /** Absolute URL of the full page the chart comes from. */
  pageUrl: string;
  /** Descriptive iframe title. */
  title: string;
}

export const fscEmbedPath = (code: string): string => `/embed/fsc/${code}/demand/`;
export const nsnEmbedPath = (dashed: string): string => `/embed/nsn/${dashed}/price/`;

export const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The two-element snippet from mockup card 23, with real URLs. */
export function embedSnippet(e: EmbedInfo): string {
  return (
    `<iframe src="${escapeAttr(e.src)}" width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}"\n` +
    `        loading="lazy" title="${escapeAttr(e.title)}"></iframe>\n` +
    `<p>Source: <a href="${escapeAttr(e.pageUrl)}">NSN Explorer</a></p>`
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 4, 2026" in UTC: the build date for prerendered embeds, the request date for on-demand ones. */
export function embedDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
