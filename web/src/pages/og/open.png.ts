// /og/open.png — the share card for the open-demand hub and the home page.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { pngResponse, renderCard } from '../../lib/og-card';

export const prerender = true;

const fmt = (n: number): string => n.toLocaleString('en-US');

export const GET: APIRoute = async () => {
  const data = await loadSiteData();
  const png = await renderCard({
    eyebrow: 'Open demand',
    title: 'What the government is buying right now',
    stats: [
      { value: fmt(data.stats.openSolicitationsCount), label: 'open solicitations' },
      { value: fmt(data.stats.openClosingSoon), label: 'closing within 7 days' },
      { value: fmt(data.solicitationsByFsc.size), label: 'federal supply classes' },
    ],
    asOf: data.viz.today,
  });
  return pngResponse(png);
};
