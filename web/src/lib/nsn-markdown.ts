// Markdown rendering of one NSN record for LLMs and agents (/nsn/<dashed>.md).
// Built from the same loader result as the HTML page; only sections that have
// data are emitted. Pure: no I/O.
import type { NsnPageData } from './nsn-page';
import { amscGloss, formatUsdPrecise, parseCharacteristics, toDashedNsn } from './shared';
import { nsnCopyInputFrom } from './nsn-copy';
import { niinDashed, nomen, nsnSummary } from './seo-copy';

const MAX_PRICE_ROWS = 50;
const MAX_AWARD_ROWS = 25;

const cell = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const table = (head: string[], rows: (string | number | null | undefined)[][]): string =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const link = (text: string, url: string): string => `[${text.replace(/[\[\]]/g, '')}](${url})`;
const int = (n: number): string => n.toLocaleString('en-US');

export function nsnMarkdown(page: NsnPageData, siteUrl: string): string {
  const copy = nsnCopyInputFrom(page);
  const { nsn, fsc, pricePoints, contractActions, solicitations, partNumbers } = page;
  const dashed = toDashedNsn(nsn.nsn);
  const out: string[] = [`# NSN ${dashed}: ${nomen(nsn.itemName)}`, '', nsnSummary(copy), ''];

  // Identification
  const ident = [
    `- NSN: ${dashed} (${nsn.nsn})`,
    `- NIIN: ${niinDashed(nsn.nsn)} (${nsn.niin})`,
    `- Item name: ${nsn.itemName ?? 'not recorded'}`,
    `- Federal Supply Class: ${link(`FSC ${copy.fscCode}${copy.fscName ? ` ${copy.fscName}` : ''}`, `${siteUrl}/fsc/${copy.fscCode}/`)}`,
  ];
  if (fsc?.fsg) ident.push(`- Federal Supply Group: ${link(`FSG ${fsc.fsg}`, `${siteUrl}/group/${fsc.fsg}/`)}`);
  if (nsn.amsc) ident.push(`- Acquisition method suffix code: ${amscGloss(nsn.amsc) ?? nsn.amsc}${nsn.amscObservedOn ? ` (observed ${nsn.amscObservedOn})` : ''}`);
  if (nsn.amc) ident.push(`- Acquisition method code: ${nsn.amc}`);
  if (nsn.hazmat !== null) ident.push(`- Hazardous material: ${nsn.hazmat ? 'yes' : 'no'}`);
  out.push('## Identification', '', ...ident, '');

  const characteristics = parseCharacteristics(nsn.characteristics);
  if (characteristics.length > 0) {
    out.push('## Characteristics', '', table(['Code', 'Requirement', 'Reply'], characteristics.map((c) => [c.mrc, c.requirement, c.reply])), '');
  }

  if (partNumbers.length > 0) {
    out.push('## Part numbers', '', table(['Part number', 'CAGE', 'Supplier', 'Source'], partNumbers.map((p) => [p.partNumber, p.cage, p.supplierName, link(p.source, p.sourceUrl)])), '');
  }

  const open = solicitations
    .filter((s) => s.status === 'open')
    .sort((a, b) => (a.returnBy ?? '9999').localeCompare(b.returnBy ?? '9999'));
  if (open.length > 0) {
    out.push('## Open solicitations', '', table(['Solicitation', 'Quantity', 'Closes', 'Link'], open.map((s) => [s.solNumber, s.quantity !== null ? int(s.quantity) : null, s.returnBy, link(s.source === 'sam_gov' ? 'SAM.gov' : 'DIBBS', s.sourceUrl)])), '');
  }

  if (pricePoints.length > 0) {
    const newest = [...pricePoints].sort((a, b) => b.awardedOn.localeCompare(a.awardedOn));
    out.push('## Price history', '', `Newest first${newest.length > MAX_PRICE_ROWS ? `; the ${MAX_PRICE_ROWS} most recent of ${int(newest.length)} purchases` : ''}.`, '');
    out.push(table(['Date', 'Unit price', 'Quantity', 'Supplier', 'Agency', 'Source'], newest.slice(0, MAX_PRICE_ROWS).map((p) => [p.awardedOn, formatUsdPrecise(p.unitPrice), p.quantity !== null ? int(p.quantity) : null, p.supplierName ?? p.cage, p.agencyName, link('record', p.sourceUrl)])), '');
  }

  if (contractActions.length > 0) {
    const newest = [...contractActions].sort((a, b) => (b.actionDate ?? '').localeCompare(a.actionDate ?? ''));
    out.push('## Contract awards', '', `Newest first${newest.length > MAX_AWARD_ROWS ? `; the ${MAX_AWARD_ROWS} most recent of ${int(newest.length)} awards` : ''}.`, '');
    out.push(table(['Date', 'Award', 'Description', 'Recipient', 'Amount'], newest.slice(0, MAX_AWARD_ROWS).map((c) => [c.actionDate, link(c.piid ?? 'record', c.sourceUrl), (c.description ?? '').slice(0, 120), c.recipientName, c.obligation !== null ? formatUsdPrecise(c.obligation) : null])), '');
  }

  const sources = [
    `- DLA DIBBS RFQs for this NSN: https://www.dibbs.bsm.dla.mil/RFQ/RFQNsn.aspx?value=${nsn.nsn}&category=nsn`,
    `- DLA DIBBS awards for this NSN: https://www.dibbs.bsm.dla.mil/Awards/AwdRecs.aspx?category=awdnsn&TypeSrch=cq&Value=${nsn.nsn}`,
  ];
  if (nsn.amscSourceUrl) sources.push(`- AMSC record: ${nsn.amscSourceUrl}`);
  if (contractActions.length > 0) sources.push('- USAspending contract actions (each award above links to its record)');
  sources.push('- All data is public U.S. government data; every row above links to its source record where one exists.');
  out.push('## Sources', '', ...sources, '');

  out.push(`Canonical page: ${siteUrl}/nsn/${dashed}/`, `JSON: ${siteUrl}/api/nsn/${dashed}.json`, '');
  return out.join('\n');
}
