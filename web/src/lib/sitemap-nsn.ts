// Shared constants for the prerendered NSN sitemap files
// (pages/sitemap-nsn-[n].xml.ts and pages/sitemap-nsn-index.xml.ts).
export const NSN_SITEMAP_MAX_URLS = 40000;

/** Splits a list into sitemap-sized chunks (no empty chunks). */
export function chunkNsns(codes: string[], size = NSN_SITEMAP_MAX_URLS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
}
