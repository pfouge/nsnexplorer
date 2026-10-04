// Build-time llms.txt for AI crawlers/agents. See https://llmstxt.org/
// Mirrors the static site structure; link examples are real records from the
// same build snapshot. No try/catch around loadSiteData(): per web-spec.md
// "Data honesty rules" the build must fail loudly if the underlying data is
// broken, same as every other page.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../lib/data';
import { fsgName } from '../lib/browse';
import { listedFscName } from '../lib/seo-copy';
import { toDashedNsn } from '../lib/shared';
import { SITE_NAME, SITE_URL, SITE_DESCRIPTION, CONTACT_EMAIL } from '../consts';

export const prerender = true;

/** Soft size budget for the whole file; the supply-class list is trimmed to fit. */
const MAX_BYTES = 15_000;
const int = (n: number): string => n.toLocaleString('en-US');
const bytes = (s: string): number => new TextEncoder().encode(s).length;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();

  // Real examples from the snapshot (deterministic): the largest class with a handbook
  // name, its first NSN that has a name, price history and part numbers, and the busiest service letter.
  const classes = data.deepFscs
    .map((f) => ({ ...f, count: data.nsnsByFsc.get(f.fsc)?.length ?? 0, listed: listedFscName(f.fsc, f.name) }))
    .filter((f) => f.count > 0);
  const bySize = [...classes].sort((a, b) => b.count - a.count || a.fsc.localeCompare(b.fsc));
  const largest = bySize.find((c) => c.listed !== null) ?? bySize[0];
  const exampleCode = largest?.fsc ?? '5340';
  const exampleFsg = largest?.fsg ?? exampleCode.slice(0, 2);
  const inClass = [...(data.nsnsByFsc.get(exampleCode) ?? [])].sort((a, b) => a.nsn.localeCompare(b.nsn));
  const priced = (n: (typeof inClass)[number]) => !!n.itemName && (data.pricePointsByNsn.get(n.nsn)?.length ?? 0) > 0;
  const exampleNsn = inClass.find((n) => priced(n) && (data.partNumbersByNsn.get(n.nsn)?.length ?? 0) > 0) ?? inClass.find(priced) ?? inClass[0];
  const exampleDashed = exampleNsn ? toDashedNsn(exampleNsn.nsn) : `${exampleCode}-00-000-0000`;
  const examplePart = exampleNsn ? data.partNumbersByNsn.get(exampleNsn.nsn)?.[0]?.partNumber : undefined;
  const exampleLetter =
    [...data.serviceNoticesByCategory.entries()]
      .filter(([k, v]) => k !== 'other' && v.length > 0)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[0]
      .toLowerCase() ?? 'j';

  const head = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

NSN Explorer indexes ${int(data.stats.totalNsns)} National Stock Numbers (NSNs) across ${int(classes.length)} federal supply classes, with ${int(data.openSolicitations.length)} open DLA solicitations and ${int(data.serviceNotices.length)} open SAM.gov service notices at build time. Each NSN page shows the item name, FLIS characteristics, manufacturer part numbers, open RFQs, award price history and contract awards, every figure linked to its government source record.

## Data sources and update cadence
- DLA DIBBS: open RFQs and award records, updated daily.
- SAM.gov: open federal service notices, updated daily.
- PUB LOG / FLIS: item names, characteristics and part numbers, updated nightly.
- USAspending: contract actions for supply classes 5331 and 5330, updated daily.
- All data is public U.S. government data; every figure links to its source record.

## How to look things up
- NSN page: ${SITE_URL}/nsn/<NSN-with-dashes>/ (example: ${SITE_URL}/nsn/${exampleDashed}/)
- NSN as Markdown: ${SITE_URL}/nsn/<NSN-with-dashes>.md (example: ${SITE_URL}/nsn/${exampleDashed}.md)
- NSN as JSON: ${SITE_URL}/api/nsn/<NSN-with-dashes>.json (example: ${SITE_URL}/api/nsn/${exampleDashed}.json)
- Find an NSN from an NSN, a 9-digit NIIN or a part number: ${SITE_URL}/api/lookup.json?q=<query> (example: ${SITE_URL}/api/lookup.json?q=${encodeURIComponent(examplePart ?? exampleDashed)})
- Supply class: ${SITE_URL}/fsc/<code>/ (example: ${SITE_URL}/fsc/${exampleCode}/); large classes are paginated at /fsc/<code>/page/<n>/
- Supply class as Markdown: ${SITE_URL}/fsc/<code>.md (example: ${SITE_URL}/fsc/${exampleCode}.md)
- Open solicitations in a class: ${SITE_URL}/open/<code>/ (example: ${SITE_URL}/open/${exampleCode}/)
- Supply group: ${SITE_URL}/group/<two-digit-group>/ (example: ${SITE_URL}/group/${exampleFsg}/, ${fsgName(exampleFsg)})
- Service notices overview: ${SITE_URL}/services/
- Service notices by category letter: ${SITE_URL}/services/<letter>/ (example: ${SITE_URL}/services/${exampleLetter}/)

## Core pages
- [Home](${SITE_URL}/) — search any NSN for its full recorded price history.
- [Services](${SITE_URL}/services/) — open federal service notices from SAM.gov by service category.
- [Browse deep categories](${SITE_URL}/browse/) — Federal Supply Classes with fully-indexed price history.
- [Open demand](${SITE_URL}/open/) — every open DLA solicitation by supply class.
- [Agencies](${SITE_URL}/agencies/) — purchases grouped by buying agency.
- [Methodology](${SITE_URL}/methodology/) — how prices are sourced and linked to public records.
- [About](${SITE_URL}/about/) — who runs this site and how to reach us.

## Sitemaps
- [Site sitemap index](${SITE_URL}/sitemap-index.xml) — hubs, classes, groups, open-demand and service pages.
- [NSN sitemap index](${SITE_URL}/sitemap-nsn-index.xml) — every NSN page, at most 40,000 per file.
`;
const tail = `
## Contact
- Email: ${CONTACT_EMAIL}
- Site: ${SITE_URL}
`;

  // Supply-class list: real handbook names only, largest classes first, trimmed to the size budget.
  const named = classes.filter((c) => c.listed !== null);
  const omittedUnnamed = classes.length - named.length;
  const ranked = [...named].sort((a, b) => b.count - a.count || a.fsc.localeCompare(b.fsc));
  const lineOf = (c: (typeof named)[number]) => `- [${c.fsc} ${c.listed}](${SITE_URL}/fsc/${c.fsc}/)`;
  const reserve = 520 + bytes(tail); // heading + explanatory notes + contact
  let budget = MAX_BYTES - bytes(head) - reserve;
  const shown: typeof named = [];
  for (const c of ranked) {
    const cost = bytes(lineOf(c)) + 1;
    if (cost > budget) break;
    budget -= cost;
    shown.push(c);
  }
  shown.sort((a, b) => a.fsc.localeCompare(b.fsc));
  const notes: string[] = [];
  if (omittedUnnamed > 0) notes.push(`${int(omittedUnnamed)} ${omittedUnnamed === 1 ? 'class' : 'classes'} without a published handbook name ${omittedUnnamed === 1 ? 'is' : 'are'} omitted from this list.`);
  if (shown.length < named.length) notes.push(`${int(named.length - shown.length)} smaller classes are not listed here to keep this file short; all are in the sitemaps and at ${SITE_URL}/browse/.`);

  const body = `${head}
## Supply classes
Format: class code, then class name; each links to /fsc/<code>/. Largest classes by NSN count.
${shown.map(lineOf).join('\n') || '- No classes are indexed yet.'}
${notes.length > 0 ? `\n${notes.join(' ')}\n` : ''}${tail}`;

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
