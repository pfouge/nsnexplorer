// ingest/sam/resource-links.mjs
// SAM.gov notices carry `resourceLinks`, an array of download URLs for the notice's attachments. The whole record is
// stored in pub.solicitations.raw, which the public site can read, so no link may carry a secret into it. SAM.gov
// sends links with an empty or "null" api_key; if one ever arrives with a real key or token value, the value is
// replaced by REDACTED before the record is stored. The site (web/src/lib/sam-attachments.ts) never shows a link
// whose key or token has a value, so a redacted link is counted but not linked. Files are never downloaded here:
// only the link list is kept.

const SECRET_PARAM = /([?&](?:api_key|apikey|token)=)([^&#\s]*)/gi;
const EMPTY = new Set(['', 'null', 'undefined']);

/** One link with any key or token value replaced by REDACTED; the same string when there is none. */
export function redactLink(url) {
  if (typeof url !== 'string') return url;
  return url.replace(SECRET_PARAM, (m, head, value) => (EMPTY.has(value.trim().toLowerCase()) || value === 'REDACTED' ? m : `${head}REDACTED`));
}

/**
 * The record to store: `rec` itself when its links need no change (so nothing is copied for the ordinary case),
 * otherwise a shallow copy with a cleaned `resourceLinks`. Entries may be URL strings (what SAM.gov sends) or
 * objects with a url, link or href.
 */
export function cleanResourceLinks(rec) {
  const links = rec?.resourceLinks;
  if (!Array.isArray(links)) return rec;
  let changed = false;
  const cleaned = links.map((entry) => {
    if (typeof entry === 'string') {
      const c = redactLink(entry);
      if (c !== entry) changed = true;
      return c;
    }
    if (entry && typeof entry === 'object') {
      const out = { ...entry };
      for (const k of ['url', 'link', 'href']) {
        if (typeof out[k] === 'string') {
          const c = redactLink(out[k]);
          if (c !== out[k]) { out[k] = c; changed = true; }
        }
      }
      return out;
    }
    return entry;
  });
  return changed ? { ...rec, resourceLinks: cleaned } : rec;
}

/** Number of attachment links a record lists (0 when none). */
export function countResourceLinks(rec) {
  return Array.isArray(rec?.resourceLinks) ? rec.resourceLinks.length : 0;
}
