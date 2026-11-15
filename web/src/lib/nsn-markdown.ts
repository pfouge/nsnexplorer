// Markdown rendering of one NSN record for LLMs and agents (/nsn/<dashed>.md).
// Built from the same loader result as the HTML page; only sections that have
// data are emitted. Pure: no I/O.
import type { NsnPageData } from './nsn-page';
import { amscGloss, competitionOf, formatUsdPrecise, parseCharacteristics, toDashedNsn } from './shared';
import { nsnCopyInputFrom } from './nsn-copy';
import { competitionRead } from './competition-read';
import { priceSummary } from './sol-history';
import { niinDashed, nomen, nsnSummary } from './seo-copy';
import { NO_DEFINITION, alsoCalled, catalogCells, foreignSummary, moeView } from './nsn-flis';
import { CEILING_LABEL, ceilingAmountText } from './contract-ceiling';
import { PRICE_EXPLAINER, SHELF_LIFE_SOURCE_LABEL, SHELF_LIFE_SOURCE_URL, mgmtView } from './nsn-mgmt';

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
  const { nsn, fsc, solicitations, partNumbers, contractActions } = page;
  // Base awards of long-term contracts carry a ceiling, not a price: they stay in the award list and the win
  // record, and are left out of the price headline and history (lib/contract-ceiling.ts).
  const allPricePoints = page.pricePoints;
  const pricePoints = allPricePoints.filter((p) => !p.isCeiling);
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

  // Catalog record (FLIS): decoded identification codes and the US management rows.
  const cells = catalogCells(page.flis.identification);
  const moe = moeView(page.flis.moeRules);
  const foreign = foreignSummary(moe);
  const also = alsoCalled(page.flis);
  if (cells.length > 0 || moe.us.length > 0 || foreign !== null || also !== null) {
    out.push('## Catalog record', '');
    if (cells.length > 0) {
      out.push(...cells.map((c) => (c.key === 'assigned' ? `- ${c.label}: ${c.value}` : `- ${c.label}: ${c.value} (${c.meaning ?? NO_DEFINITION})`)));
    }
    if (also) out.push(`- Also called: ${also}`);
    if (cells.length > 0 || also) out.push('');
    if (moe.us.length > 0) {
      out.push(
        '### Who manages it',
        '',
        table(
          ['Service or agency', 'AMC', 'AMSC', 'Acquisition advice', 'Manager', 'Retail manager', 'Since'],
          moe.us.map((r) => [r.service, r.amc, r.amsc, r.aac ? (r.aacLabel ?? `${r.aac} (${NO_DEFINITION})`) : null, r.manager, r.retail, r.since])
        ),
        ''
      );
    }
    if (foreign) out.push(`${foreign}: ${[...moe.foreignNames, ...moe.otherNames].join(', ')}.`, '');
  }

  // Government supply record (PUB LOG management data). The last award is the newest positive non-ceiling price.
  const newestPriced = [...pricePoints].sort((a, b) => b.awardedOn.localeCompare(a.awardedOn)).find((p) => Number.isFinite(p.unitPrice) && p.unitPrice > 0);
  const mg = mgmtView(page.flis.management, newestPriced ? { price: newestPriced.unitPrice, awardedOn: newestPriced.awardedOn } : null);
  if (mg.has) {
    out.push('## Government supply record', '');
    if (mg.price) out.push(PRICE_EXPLAINER, '');
    if (mg.priceLine) out.push(`- Government standard price: ${mg.priceLine}${mg.effectiveLine ? ` (effective ${mg.effectiveLine})` : ''}`);
    if (mg.shelfLifeLine) out.push(`- Shelf life: ${mg.shelfLifeLine}`);
    else if (mg.shelfMixed) out.push('- Shelf life: differs by service (see the table)');
    if (mg.sosLine) out.push(`- Source of supply: ${mg.sosLine}`);
    else if (mg.sosMixed) out.push('- Source of supply: differs by service (see the table)');
    if (mg.compare) out.push(`- ${mg.compare}`);
    out.push('');
    if (mg.table.length > 0) {
      out.push(table(['Service or agency', 'Unit price', 'Unit of issue', 'Shelf life', 'Source of supply', 'Acquisition advice', 'Effective'], mg.table.map((r) => [r.scope, r.price, r.ui, r.shelfLife, r.sos, r.aac, r.effective])), '');
    }
    if (mg.shelfLifeLine || mg.shelfMixed) out.push(`Shelf life codes: ${link(SHELF_LIFE_SOURCE_LABEL, SHELF_LIFE_SOURCE_URL)}.`, '');
  }

  const characteristics = parseCharacteristics(nsn.characteristics);
  if (characteristics.length > 0) {
    out.push('## Characteristics', '', table(['Code', 'Requirement', 'Reply'], characteristics.map((c) => [c.mrc, c.requirement, c.reply])), '');
  }

  if (partNumbers.length > 0) {
    out.push('## Part numbers', '', table(['Part number', 'CAGE', 'Supplier', 'Source'], partNumbers.map((p) => [p.partNumber, p.cage, p.supplierName, link(p.source, p.sourceUrl)])), '');
  }

  const awardsForRead =
    allPricePoints.length > 0
      ? allPricePoints.map((p) => ({ cage: p.cage, date: p.awardedOn }))
      : contractActions.filter((c) => c.actionDate !== null).map((c) => ({ cage: c.cage, date: c.actionDate! }));
  const read = competitionRead({ coded: competitionOf(nsn.amc, nsn.amsc), awards: awardsForRead });
  out.push('## Competition', '', `- Read: ${read.label}. ${read.reason}`, `- Awards with a supplier considered (last 10): ${read.considered}`, '');

  const open = solicitations
    .filter((s) => s.status === 'open')
    .sort((a, b) => (a.returnBy ?? '9999').localeCompare(b.returnBy ?? '9999'));
  if (open.length > 0) {
    out.push('## Open solicitations', '', table(['Solicitation', 'Quantity', 'Closes', 'Link'], open.map((s) => [s.solNumber, s.quantity !== null ? int(s.quantity) : null, s.returnBy, link(s.source === 'sam_gov' ? 'SAM.gov' : 'DIBBS', s.sourceUrl)])), '');
  }

  if (pricePoints.length > 0) {
    const newest = [...pricePoints].sort((a, b) => b.awardedOn.localeCompare(a.awardedOn));
    const sum = priceSummary(pricePoints);
    const top = newest.find((p) => Number.isFinite(p.unitPrice) && p.unitPrice > 0);
    if (sum && top) {
      out.push('## Price headline', '', `- Most recent price: ${formatUsdPrecise(top.unitPrice)} (${top.awardedOn}, ${link('record', top.sourceUrl)})`);
      if (sum.n >= 2) out.push(`- Last ${sum.n} awards: ${formatUsdPrecise(sum.low)} to ${formatUsdPrecise(sum.high)}`, `- Average of last ${sum.n}: ${formatUsdPrecise(sum.average)}`);
      out.push(`- Prices on record: ${int(pricePoints.length)}`, '');
    }
    out.push('## Price history', '', `Newest first${newest.length > MAX_PRICE_ROWS ? `; the ${MAX_PRICE_ROWS} most recent of ${int(newest.length)} purchases` : ''}.`, '');
    out.push(table(['Date', 'Unit price', 'Quantity', 'Supplier', 'Agency', 'Source'], newest.slice(0, MAX_PRICE_ROWS).map((p) => [p.awardedOn, formatUsdPrecise(p.unitPrice), p.quantity !== null ? int(p.quantity) : null, p.supplierName ?? p.cage, p.agencyName, link('record', p.sourceUrl)])), '');
  }

  if (contractActions.length > 0) {
    const newest = [...contractActions].sort((a, b) => (b.actionDate ?? '').localeCompare(a.actionDate ?? ''));
    out.push('## Contract awards', '', `Newest first${newest.length > MAX_AWARD_ROWS ? `; the ${MAX_AWARD_ROWS} most recent of ${int(newest.length)} awards` : ''}.`, '');
    out.push(table(['Date', 'Award', 'Description', 'Recipient', 'Amount'], newest.slice(0, MAX_AWARD_ROWS).map((c) => [c.actionDate, link(c.piid ?? 'record', c.sourceUrl), (c.description ?? '').slice(0, 120), c.isCeiling ? `${CEILING_LABEL}: ${c.recipientName ?? 'recipient not named'}` : c.recipientName, c.obligation === null ? null : c.isCeiling ? ceilingAmountText(formatUsdPrecise(c.obligation)) : formatUsdPrecise(c.obligation)])), '');
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
