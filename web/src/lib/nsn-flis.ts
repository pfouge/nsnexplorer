// FLIS catalog data for one NSN: the record shapes the single-statement loader returns under `flis`, the
// pure mapper from its jsonb columns, and the presentation helpers the NSN page and the markdown twin share.
// No I/O and no database imports (this file is bundled for the Workers runtime and unit-tested directly).
import {
  cleanDefinition,
  criticalityMeaning,
  demilMeaning,
  esdEmiMeaning,
  humanizeLabel,
  moeKind,
} from './flis-codes.ts';
import { nomen } from './seo-copy.ts';
import { type NsnMgmt, mapMgmt } from './nsn-mgmt.ts';
import { type NsnShipping, mapShipping } from './nsn-shipping.ts';

// Same output as shared.ts formatDate / toDashedNsn; copied (shared.ts is not loadable under node --test).
const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
const toDashedNsn = (n: string): string => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9, 13)}`;

/** Shown next to a code whose meaning is not in pub.flis_codes or the hard-coded tables. */
export const NO_DEFINITION = 'definition not on file';

export interface FlisFieldDefinition {
  /** Field name in pub.flis_codes, e.g. 'PMIC'. */
  field: string;
  /** Title-cased name, e.g. 'Precious Metals Indicator'. */
  name: string | null;
  /** Sentence-case definition, at most ~200 characters. */
  text: string | null;
}

export interface FlisIdentification {
  inc: string | null;
  critCd: string | null;
  demil: string | null;
  demilIntCd: string | null;
  /** ISO date. */
  niinAssigned: string | null;
  pmic: string | null;
  pmicLabel: string | null;
  adp: string | null;
  hmic: string | null;
  hmicLabel: string | null;
  esdEmi: string | null;
  hcc: string | null;
  hccLabel: string | null;
  scheduleB: string | null;
  /** Commodity text for the Schedule B code, sentence case. */
  scheduleBText: string | null;
  enac: string | null;
  enacLabel: string | null;
  iuidIndicator: string | null;
  iuidLabel: string | null;
  lastKnownSos: string | null;
  lastKnownSosLabel: string | null;
  sourceFileDate: string | null;
  fieldDefinitions: FlisFieldDefinition[];
}

export interface FlisRelatedItem {
  /** Dashed 13-digit NSN (or the raw published value when it is not 13 digits). */
  relatedNsn: string;
  /** True when pub.nsns has the related NSN, i.e. /nsn/<dashed>/ exists. */
  hasPage: boolean;
  isc: string | null;
  iscLabel: string | null;
  decisionBy: string | null;
  /** ISO date. */
  date: string | null;
}

export interface FlisCancellation {
  /** The older, cancelled stock number as FSC-NIIN, e.g. 5340-01-592-9109. */
  cancelledNsn: string;
  statusCode: string | null;
  statusLabel: string | null;
  /** ISO date. */
  effectiveDate: string | null;
}

export interface FlisMoeRule {
  rule: string;
  moeCode: string | null;
  moeLabel: string | null;
  /** 'us' | 'foreign' | 'other', see moeKind in flis-codes.ts. */
  kind: 'us' | 'foreign' | 'other';
  amc: string | null;
  amcLabel: string | null;
  amsc: string | null;
  amscLabel: string | null;
  aac: string | null;
  aacLabel: string | null;
  imc: string | null;
  imcLabel: string | null;
  pica: string | null;
  picaLabel: string | null;
  sica: string | null;
  sicaLabel: string | null;
  nimsc: string | null;
  /** ISO date. */
  assignedOn: string | null;
}

export interface NsnFlis {
  identification: FlisIdentification | null;
  /** Up to 8 everyday names for the item name code, in the site's item-name style ("Boot, Switch"). */
  colloquialNames: string[];
  /** Rows of pub.nsn_standardization that name a related NSN. */
  related: FlisRelatedItem[];
  relatedTotal: number;
  /** Newest first, at most 25. */
  cancellations: FlisCancellation[];
  cancellationsTotal: number;
  moeRules: FlisMoeRule[];
  /** PUB LOG management data (migration 0020): standard unit price, unit of issue, shelf life, source of supply per file / service. */
  management: NsnMgmt;
  /** PUB LOG freight and packaging data (migration 0023): packaging rows (P first) and the freight row, with decoded code meanings. */
  shipping: NsnShipping;
}

export const COLLOQUIAL_CAP = 8;
export const CANCELLATION_CAP = 25;
export const RELATED_CAP = 50;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const day = (v: unknown): string | null => {
  const s = str(v);
  return s === null ? null : s.slice(0, 10);
};
const label = (v: unknown): string | null => humanizeLabel(str(v));

const dashed13 = (digits: string): string => (/^\d{13}$/.test(digits) ? toDashedNsn(digits) : digits);

/** FSC + NIIN -> 5340-01-592-9109; a missing/odd FSC leaves just the NIIN as 01-592-9109. */
export function stockNumber(fsc: string | null, niin: string): string {
  const n = niin.trim();
  if (fsc && /^\d{4}$/.test(fsc.trim()) && /^\d{9}$/.test(n)) return toDashedNsn(fsc.trim() + n);
  return /^\d{9}$/.test(n) ? `${n.slice(0, 2)}-${n.slice(2, 5)}-${n.slice(5)}` : n;
}

export function mapFlis(row: { flis_ident?: J | null; flis_colloquial?: unknown; flis_related?: J[] | null; flis_cancel?: J[] | null; flis_moe?: J[] | null; flis_mgmt?: J[] | null; flis_packaging?: J[] | null; flis_freight?: J | null }): NsnFlis {
  const i = row.flis_ident ?? null;
  const identification: FlisIdentification | null = i
    ? {
        inc: str(i.inc),
        critCd: str(i.crit_cd),
        demil: str(i.demil),
        demilIntCd: str(i.demil_int_cd),
        niinAssigned: day(i.niin_assigned),
        pmic: str(i.pmic),
        pmicLabel: label(i.pmic_label),
        adp: str(i.adp),
        hmic: str(i.hmic),
        hmicLabel: label(i.hmic_label),
        esdEmi: str(i.esd_emi),
        hcc: str(i.hcc),
        hccLabel: label(i.hcc_label),
        scheduleB: str(i.schedule_b),
        scheduleBText: scheduleBText(str(i.schedule_b_text)),
        enac: str(i.enac),
        enacLabel: label(i.enac_label),
        iuidIndicator: str(i.iuid_indicator),
        iuidLabel: label(i.iuid_label),
        lastKnownSos: str(i.last_known_sos),
        lastKnownSosLabel: label(i.sos_label),
        sourceFileDate: day(i.source_file_date),
        fieldDefinitions: ((i.field_defs as J[] | null) ?? []).map((d) => ({
          field: String(d.field),
          name: label(d.literal),
          text: cleanDefinition(str(d.description)),
        })),
      }
    : null;

  const names = Array.isArray(row.flis_colloquial) ? (row.flis_colloquial as unknown[]) : [];
  const seen = new Set<string>();
  const colloquialNames: string[] = [];
  for (const n of names) {
    const raw = str(n);
    const t = raw === null ? null : nomen(raw); // item-name style: "BOOT,SWITCH" -> "Boot, Switch"
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      colloquialNames.push(t);
    }
    if (colloquialNames.length >= COLLOQUIAL_CAP) break;
  }

  const relRows = row.flis_related ?? [];
  const related: FlisRelatedItem[] = relRows.map((r) => ({
    relatedNsn: dashed13(String(r.related_nsn)),
    hasPage: r.has_page === true && /^\d{13}$/.test(String(r.related_nsn)),
    isc: str(r.isc),
    iscLabel: label(r.isc_label),
    decisionBy: label(r.dec_label),
    date: day(r.stdzn_date),
  }));

  const canRows = row.flis_cancel ?? [];
  const cancellations: FlisCancellation[] = canRows.map((r) => ({
    cancelledNsn: stockNumber(str(r.cancelled_fsc), String(r.cancelled_niin)),
    statusCode: str(r.status),
    statusLabel: label(r.status_label),
    effectiveDate: day(r.eff_date),
  }));

  const moeRules: FlisMoeRule[] = (row.flis_moe ?? []).map((r) => ({
    rule: String(r.moe_rl),
    moeCode: str(r.moe_cd),
    moeLabel: label(r.moe_label),
    kind: moeKind(str(r.moe_cd)),
    amc: str(r.amc),
    amcLabel: label(r.amc_label),
    amsc: str(r.amsc),
    amscLabel: label(r.amsc_label),
    aac: str(r.aac),
    aacLabel: label(r.aac_label),
    imc: str(r.imc),
    imcLabel: label(r.imc_label),
    pica: str(r.pica),
    picaLabel: label(r.pica_label),
    sica: str(r.sica),
    sicaLabel: label(r.sica_label),
    nimsc: str(r.nimsc),
    assignedOn: day(r.assigned_on),
  }));

  return {
    identification,
    colloquialNames,
    related,
    relatedTotal: relRows.length > 0 ? Number(relRows[0].total) : 0,
    cancellations,
    cancellationsTotal: canRows.length > 0 ? Number(canRows[0].total) : 0,
    moeRules,
    management: mapMgmt(row.flis_mgmt),
    shipping: mapShipping(row.flis_packaging, row.flis_freight),
  };
}

/** Commodity text from the dictionary: sentence case, no trailing period, at most ~90 characters. */
function scheduleBText(raw: string | null): string | null {
  const t = cleanDefinition(raw, 90);
  return t === null ? null : t.replace(/\.$/, '').replace(/,(?=\S)/g, ', ');
}

// ---------------------------------------------------------------------------------------------
// Presentation

export interface CatalogCell {
  key: 'assigned' | 'demil' | 'criticality' | 'hazmat' | 'precious' | 'esd' | 'scheduleB';
  label: string;
  /** The code, or the formatted date for "Assigned". */
  value: string;
  /** Plain-language meaning; null when no definition is on file. */
  meaning: string | null;
}

/** Cells of the "Catalog record" strip; fields with no value are omitted. */
export function catalogCells(i: FlisIdentification | null): CatalogCell[] {
  if (!i) return [];
  const cells: CatalogCell[] = [];
  if (i.niinAssigned) cells.push({ key: 'assigned', label: 'Assigned', value: formatDate(i.niinAssigned), meaning: null });
  if (i.demil) cells.push({ key: 'demil', label: 'DEMIL', value: i.demil, meaning: demilMeaning(i.demil) });
  if (i.critCd) cells.push({ key: 'criticality', label: 'Criticality', value: i.critCd, meaning: criticalityMeaning(i.critCd) });
  if (i.hmic) cells.push({ key: 'hazmat', label: 'Hazardous material', value: i.hmic, meaning: i.hmicLabel });
  if (i.pmic) cells.push({ key: 'precious', label: 'Precious metals', value: i.pmic, meaning: i.pmicLabel });
  if (i.esdEmi) cells.push({ key: 'esd', label: 'Static/EMI sensitive', value: i.esdEmi, meaning: esdEmiMeaning(i.esdEmi) });
  if (i.scheduleB) cells.push({ key: 'scheduleB', label: 'Schedule B', value: i.scheduleB, meaning: i.scheduleBText });
  return cells;
}

/** "Also called" line: names are already capped and title-cased by the mapper. */
export const alsoCalled = (f: NsnFlis): string | null => (f.colloquialNames.length > 0 ? f.colloquialNames.join('; ') : null);

export interface UsManagerRow {
  service: string;
  amc: string | null;
  amcLabel: string | null;
  amsc: string | null;
  amscLabel: string | null;
  aac: string | null;
  aacLabel: string | null;
  manager: string | null;
  /** Retail manager, only when it differs from the primary manager. */
  retail: string | null;
  since: string | null;
}

export interface MoeView {
  us: UsManagerRow[];
  /** Distinct foreign governments (by MOE code), names sorted. */
  foreignNames: string[];
  /** Distinct organizations treated as "other", names sorted. */
  otherNames: string[];
}

const nameOf = (r: FlisMoeRule): string => r.moeLabel ?? r.moeCode ?? 'Unknown';

export function moeView(rules: FlisMoeRule[]): MoeView {
  const us: UsManagerRow[] = [];
  const foreign = new Map<string, string>();
  const other = new Map<string, string>();
  for (const r of rules) {
    if (r.kind === 'us') {
      const manager = r.picaLabel ?? r.pica;
      const sicaDiffers = r.sica !== null && r.sica !== r.pica;
      us.push({
        service: nameOf(r),
        amc: r.amc,
        amcLabel: r.amcLabel,
        amsc: r.amsc,
        amscLabel: r.amscLabel,
        aac: r.aac,
        aacLabel: r.aacLabel,
        manager,
        retail: sicaDiffers ? (r.sicaLabel ?? r.sica) : null,
        since: r.assignedOn,
      });
    } else {
      const target = r.kind === 'foreign' ? foreign : other;
      target.set(r.moeCode ?? r.rule, nameOf(r));
    }
  }
  const names = (m: Map<string, string>): string[] => [...new Set(m.values())].sort((a, b) => a.localeCompare(b));
  return { us, foreignNames: names(foreign), otherNames: names(other) };
}

/** Summary line for the collapsed foreign-government list; null when there are none. */
export function foreignSummary(v: MoeView): string | null {
  if (v.foreignNames.length === 0 && v.otherNames.length === 0) return null;
  const parts: string[] = [];
  if (v.foreignNames.length > 0) parts.push(`${v.foreignNames.length} other ${v.foreignNames.length === 1 ? 'government' : 'governments'}`);
  if (v.otherNames.length > 0) parts.push(`${v.otherNames.length} other ${v.otherNames.length === 1 ? 'organization' : 'organizations'}`);
  return `Also registered by ${parts.join(' and ')}`;
}

/** Related items that can be shown (the loader only returns rows that name a related NSN). */
export const hasFlisContent = (f: NsnFlis): boolean =>
  f.identification !== null || f.related.length > 0 || f.cancellations.length > 0 || f.moeRules.length > 0;
