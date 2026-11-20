// Advertising gate. Pure so it can be unit tested; the publisher id and the unit flag live
// in ads-config.ts (the switch file) and BaseLayout calls this for every page.

/** "ca-pub-" followed by 16 digits. Anything else counts as not set. */
export const ADSENSE_CLIENT_RE = /^ca-pub-\d{16}$/;

export interface AdsInput {
  /** ADSENSE_CLIENT from ads-config.ts. */
  client: string;
  /** import.meta.env.PROD: never in dev or preview-of-dev builds. */
  prod: boolean;
  /** The page's own opt-in. Defaults to false; only allowlisted page types pass true. */
  ads: boolean;
  /** The page's noindex prop (true, 'follow' or false/undefined). */
  noindex: boolean | 'follow' | undefined;
}

/**
 * True only when a valid publisher id is set, this is a production build, the page type
 * opted in, and the page is indexable. Pages without publisher content (404, search
 * results, error and empty states, legal pages, embeds) never opt in; noindex forces
 * the tag off even if a page forgets.
 */
export function adsEnabled({ client, prod, ads, noindex }: AdsInput): boolean {
  return prod && ADSENSE_CLIENT_RE.test(client) && ads === true && !noindex;
}
