// /og/class-<fsc>.png — the share card for a federal supply class. Used by
// the class page, the open-demand class page and every part page in the
// class. Prerendered at build time, so the figures are as fresh as the deploy.
import type { APIRoute } from 'astro';
import { loadSiteData } from '../../lib/data';
import { fscDisplayName } from '../../lib/browse';
import { pngResponse, renderCard } from '../../lib/og-card';

export const prerender = true;

const fmt = (n: number): string => n.toLocaleString('en-US');

export async function getStaticPaths() {
  const data = await loadSiteData();
  const names = new Map<string, string | null>();
  for (const f of data.deepFscs) names.set(f.fsc, f.name);
  for (const [fsc, entry] of data.solicitationsByFsc) if (!names.get(fsc)) names.set(fsc, entry.name);
  return [...names.entries()].map(([fsc, name]) => ({ params: { fsc }, props: { fsc, name } }));
}

export const GET: APIRoute = async ({ props }) => {
  const { fsc, name } = props as { fsc: string; name: string | null };
  const data = await loadSiteData();
  const open = data.openByFsc.get(fsc)?.solicitations ?? [];
  const all = data.solicitationsByFsc.get(fsc)?.solicitations ?? [];
  const cutoff = new Date(`${data.viz.today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 7);
  const closing = open.filter((s) => s.returnBy !== null && new Date(`${s.returnBy}T00:00:00Z`) <= cutoff).length;
  const nsns = data.nsnsByFsc.get(fsc) ?? [];
  const purchases = nsns.reduce((n, x) => n + (data.pricePointsByNsn.get(x.nsn)?.length ?? 0), 0);
  // A class with no solicitations on record still has a card: its catalog counts.
  const stats =
    all.length > 0
      ? [
          { value: fmt(open.length), label: open.length === 1 ? 'open solicitation' : 'open solicitations' },
          { value: fmt(closing), label: 'closing within 7 days' },
          { value: fmt(all.length), label: 'solicitations on record' },
        ]
      : [
          { value: fmt(nsns.length), label: 'stock numbers tracked' },
          { value: fmt(purchases), label: 'priced purchases on record' },
        ];
  const png = await renderCard({
    eyebrow: `Federal supply class ${fsc}`,
    title: fscDisplayName(fsc, name),
    stats,
    asOf: data.viz.today,
  });
  return pngResponse(png);
};
