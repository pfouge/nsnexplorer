// GET /fsc/{code}.md — Markdown twin of /fsc/{code}/ for LLMs and agents.
// Prerendered at build time from the same snapshot as the HTML pages.
import type { APIRoute } from 'astro';
import { SITE_URL } from '../../consts';
import { loadSiteData, type FscConfig } from '../../lib/data';
import { fsgName } from '../../lib/browse';
import { PAGE_SIZE, pageCount } from '../../lib/paginate';
import { fscLabel, listedFscName, nomen } from '../../lib/seo-copy';
import { toDashedNsn } from '../../lib/shared';

export const prerender = true;

const MAX_ROWS = PAGE_SIZE;
const int = (n: number): string => n.toLocaleString('en-US');
const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export async function getStaticPaths() {
  const data = await loadSiteData();
  return data.deepFscs.map((fsc: FscConfig) => ({ params: { fsc: fsc.fsc }, props: { fsc } }));
}

export const GET: APIRoute = async ({ props }) => {
  const { fsc } = props as { fsc: FscConfig };
  const data = await loadSiteData();
  const nsns = [...(data.nsnsByFsc.get(fsc.fsc) ?? [])].sort((a, b) => a.nsn.localeCompare(b.nsn));
  const open = data.openByFsc.get(fsc.fsc)?.solicitations.length ?? 0;
  const hasOpenPage = data.solicitationsByFsc.has(fsc.fsc);
  const listed = listedFscName(fsc.fsc, fsc.name);
  const label = fscLabel(fsc.fsc, listed);
  const pages = pageCount(nsns.length);

  const lines: string[] = [
    `# ${label}`,
    '',
    `${label} is a Federal Supply Class in Federal Supply Group ${fsc.fsg}, ${fsgName(fsc.fsg)}. NSN Explorer tracks ${int(nsns.length)} ${nsns.length === 1 ? 'NSN' : 'NSNs'} in this class` +
      `${open > 0 ? ` and ${int(open)} open ${open === 1 ? 'solicitation' : 'solicitations'} right now` : ''}. ` +
      'Every figure links to a public U.S. government source record.',
    '',
    `- NSNs tracked: ${int(nsns.length)}`,
    `- Open solicitations: ${int(open)}`,
    `- HTML page: ${SITE_URL}/fsc/${fsc.fsc}/`,
    ...(hasOpenPage ? [`- Open demand: ${SITE_URL}/open/${fsc.fsc}/`] : []),
    `- Supply group: ${SITE_URL}/group/${fsc.fsg}/`,
    '',
  ];
  if (nsns.length > 0) {
    lines.push('## NSNs', '', '| NSN | Item name | Page |', '| --- | --- | --- |');
    for (const n of nsns.slice(0, MAX_ROWS)) {
      const dashed = toDashedNsn(n.nsn);
      lines.push(`| ${dashed} | ${cell(nomen(n.itemName))} | [${dashed}](${SITE_URL}/nsn/${dashed}/) |`);
    }
    lines.push('');
    if (nsns.length > MAX_ROWS) {
      lines.push(
        `This table shows the first ${int(MAX_ROWS)} of ${int(nsns.length)} NSNs in NSN order. The rest are on the HTML pages: ` +
          `${SITE_URL}/fsc/${fsc.fsc}/ (${pages} pages; page 2 is ${SITE_URL}/fsc/${fsc.fsc}/page/2/).`,
        ''
      );
    }
  }
  lines.push(`Canonical page: ${SITE_URL}/fsc/${fsc.fsc}/`, '');
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
