// Build-time llms.txt for AI crawlers/agents. See https://llmstxt.org/
// Mirrors the static site structure; deep-category links are generated from
// loadSiteData() the same way browse.astro does. No try/catch around
// loadSiteData(): per web-spec.md "Data honesty rules" the build must fail
// loudly if the underlying data is broken, same as every other page.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../lib/data';
import { SITE_NAME, SITE_URL, SITE_DESCRIPTION, CONTACT_EMAIL } from '../consts';

export const prerender = true;

export const GET: APIRoute = async () => {
  const data = await loadSiteData();

  const categoryLines = data.deepFscs
    .map((f) => {
      const count = data.nsnsByFsc.get(f.fsc)?.length ?? 0;
      const suffix = count > 0 ? ` (${count.toLocaleString('en-US')} NSNs)` : '';
      return `- [FSC ${f.fsc} — ${f.name}](${SITE_URL}/fsc/${f.fsc}/)${suffix}`;
    })
    .join('\n');

  const body = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## Core pages
- [Home](${SITE_URL}/) — search any NSN for its full recorded price history.
- [Browse deep categories](${SITE_URL}/browse/) — Federal Supply Classes with fully-indexed price history.
- [Agencies](${SITE_URL}/agencies/) — purchases grouped by buying agency.
- [Methodology](${SITE_URL}/methodology/) — how prices are sourced and linked to public records.
- [About](${SITE_URL}/about/) — who runs this site and how to reach us.

## Deep categories
${categoryLines || '- No categories are fully indexed yet.'}

## Contact
- Email: ${CONTACT_EMAIL}
- Site: ${SITE_URL}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
