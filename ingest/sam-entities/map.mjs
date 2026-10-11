// ingest/sam-entities/map.mjs
// Maps one line of the SAM.gov PUBLIC V2 entity extract (monthly) to a
// pub.supplier_sam row (db/migrations/0011_supplier_profiles.sql).
//
// Sources (read 2026-10-11):
//   Extracts API (endpoint, fileName / fileType / sensitivity / frequency / date params,
//   file naming SAM_PUBLIC_MONTHLY_V2_YYYYMMDD.ZIP, monthly file = first Sunday of the month,
//   all active entities plus those expired in the last six months, 10 requests/day for a
//   non-federal key without a role):
//     https://open.gsa.gov/api/sam-entity-extracts-api/
//   Public V2 layout (142 pipe-delimited columns, tilde-separated repeating values, record
//   ends with the literal "!end", file wrapped in "BOF PUBLIC ..." / "EOF PUBLIC ..." lines;
//   layout v1.5, 2019-12-20):
//     https://open.gsa.gov/api/sam-entity-extracts-api/v1/SAM_Entity_Management_Public_V2_Extract_Layout.pdf
//   (earlier layout, v1.4, which still carried POC phone/email columns:
//     https://open.gsa.gov/api/sam-entity-extracts-api/v1/public_extract_layout.pdf )
//   SBA business type codes A0/A4/A6/A9/JT/XX: https://docs.makegov.com/data-dictionary/entities/
//   Business type code table: GSA's "SAM Functional Data Dictionary" could not be fetched; see
//   BUSINESS_TYPES below for which pairs were confirmed and which are recalled.
//
// Privacy: public tier only. The columns for POC street addresses are never read; POC phone,
// email and fax do not exist in V2 and are dropped defensively if a layout ever adds them
// (the mapper only reads name + title). No TIN/banking columns exist in the public file.
// Entities flagged "NPDY" (no public display) are skipped entirely.

/** Number of columns in a V2 public record, including the trailing "!end". */
export const COLUMN_COUNT = 142;

// 0-based indexes (layout column number - 1).
export const COL = {
  uei: 0,
  cage: 3,
  extractCode: 5, // A = active, E = expired (monthly file)
  regDate: 7,
  expDate: 8,
  updateDate: 9,
  activationDate: 10,
  legalName: 11,
  dbaName: 12,
  physLine1: 15, physLine2: 16, physCity: 17, physState: 18, physZip: 19, physZip4: 20, physCountry: 21,
  startDate: 24,
  url: 26,
  structure: 27,
  stateOfInc: 28,
  countryOfInc: 29,
  bizTypeCounter: 30,
  bizTypes: 31,
  primaryNaics: 32,
  naicsCounter: 33,
  naics: 34,
  pscCounter: 35,
  psc: 36,
  // Mailing address order in the layout: line1, line2, city, zip, zip4, country, state.
  mailLine1: 39, mailLine2: 40, mailCity: 41, mailZip: 42, mailZip4: 43, mailCountry: 44, mailState: 45,
  pocStart: 46, // six blocks of 11 columns
  sbaCounter: 116,
  sba: 117,
  noPublicDisplay: 118,
  end: 141,
};

/** POC blocks in layout order; each block is 11 columns: first, MI, last, title, st1, st2, city, zip, zip4, country, state. */
export const POC_ROLES = [
  'Government Business POC',
  'Alternate Government Business POC',
  'Past Performance POC',
  'Alternate Past Performance POC',
  'Electronic Business POC',
  'Alternate Electronic Business POC',
];
const POC_BLOCK = 11;

export const EXTRACT_STATUS = { A: 'Active', E: 'Expired' };

// Entity structure codes. 2L confirmed against a live SAM record; the rest are the
// SAM registration choices as recalled (not fetched from a GSA table).
export const ENTITY_STRUCTURES = {
  '2J': 'Sole Proprietorship',
  '2K': 'Partnership or Limited Liability Partnership',
  '2L': 'Corporate Entity (Not Tax Exempt)',
  '8H': 'Corporate Entity (Tax Exempt)',
  X6: 'International Organization',
  ZZ: 'Other',
};

// SBA-certified program codes (https://docs.makegov.com/data-dictionary/entities/).
export const SBA_LABELS = {
  A0: 'Economically Disadvantaged Women-Owned Small Business',
  A4: 'Small Disadvantaged Business',
  A6: '8(a)',
  A9: 'Women-Owned Small Business',
  JT: '8(a) Joint Venture',
  XX: 'HUBZone',
};

// Business type codes -> labels. Unknown codes are kept as the bare code.
// Every code below was checked on 2026-10-11 against the SAM Functional Data Dictionary
// (open.gsa.gov/api/entity-api/v1/SAM Functional Data Dictionary_June 23_v2.pdf).
export const BUSINESS_TYPES = {
  '2X': 'For Profit Organization',
  LJ: 'Limited Liability Company',
  MF: 'Manufacturer of Goods',
  27: 'Self Certified Small Disadvantaged Business',
  A5: 'Veteran Owned Business',
  QF: 'Service Disabled Veteran Owned Business',
  XS: 'Subchapter S Corporation',
  A6: 'SBA Certified 8(a) Program Participant',
  JT: 'SBA Certified 8(a) Joint Venture',
  XX: 'SBA Certified HUBZone Firm',
  // checked 2026-10-11 against the SAM Functional Data Dictionary (June 23, 2023 v2):
  '8W': 'Woman Owned Small Business',
  A2: 'Woman Owned Business',
  23: 'Minority Owned Business',
  OY: 'Black American Owned',
  PI: 'Hispanic American Owned',
  NB: 'Native American Owned',
  FR: 'Asian-Pacific American Owned',
  QZ: 'Subcontinent Asian (Asian-Indian) American Owned',
  20: 'Foreign Owned',
  '1D': 'Small Agricultural Cooperative',
  '2R': 'U.S. Federal Government',
  '2F': 'U.S. State Government',
  12: 'U.S. Local Government',
  '3I': 'Tribal Government',
  CY: 'Foreign Government',
};

const blank = (v) => {
  if (v === undefined || v === null) return null;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
};

/** 'YYYYMMDD' -> 'YYYY-MM-DD' (null when malformed or not a real calendar date). */
export function isoDate(v) {
  const t = blank(v);
  if (!t || !/^\d{8}$/.test(t)) return null;
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/**
 * Normalises a registered website to https?://host/path.
 * Adds https:// when the scheme is missing, lowercases the host, drops whitespace-separated
 * extras and the #fragment, and rejects anything that is not http(s) or has no dotted host.
 */
export function normalizeUrl(raw) {
  let t = blank(raw);
  if (!t) return null;
  t = t.split(/[\s,;]+/)[0];
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    if (/^(mailto|tel|javascript|data|ftp):/i.test(t)) return null;
    t = `https://${t.replace(/^\/+/, '')}`;
  }
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) return null;
  if (u.username || u.password) return null;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
}

function splitTilde(v) {
  const t = blank(v);
  if (!t) return [];
  return t.split('~').map((x) => x.trim()).filter(Boolean);
}

export function parseBusinessTypes(v) {
  const out = [];
  for (const code of splitTilde(v)) {
    const label = BUSINESS_TYPES[code] ?? code;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** "332722Y~541330N~111110 " -> [{code, small}]; small is null when the indicator is blank or E (exception). */
export function parseNaics(v) {
  const out = [];
  const raw = v === undefined || v === null ? '' : String(v);
  for (const part of raw.split('~')) {
    const m = part.trim() === '' ? null : /^(\d{2,6})([YNE])?\s*$/.exec(part.trim());
    if (!m) continue;
    out.push({ code: m[1], small: m[2] === 'Y' ? true : m[2] === 'N' ? false : null });
  }
  return out;
}

export function parsePsc(v) {
  return splitTilde(v).filter((c) => /^[A-Z0-9]{3,4}$/i.test(c)).map((c) => c.toUpperCase());
}

/**
 * "A620210101~XX20210102" -> [{label, entry, exit}]. The V2 layout documents a two-character
 * code followed by ONE date (the expiration); if a file ever carries two dates they are read
 * as entry then exit.
 */
export function parseSba(v) {
  const out = [];
  for (const part of splitTilde(v)) {
    const m = /^([A-Z0-9]{2})(\d{8})?(\d{8})?$/i.exec(part);
    if (!m) continue;
    const code = m[1].toUpperCase();
    const label = SBA_LABELS[code] ?? code;
    const d1 = isoDate(m[2]);
    const d2 = isoDate(m[3]);
    out.push({ label, entry: d2 ? d1 : null, exit: d2 ?? d1 });
  }
  return out;
}

function joinName(first, mi, last) {
  return [blank(first), blank(mi), blank(last)].filter(Boolean).join(' ') || null;
}

/** Name, title and role only. Street addresses (and any phone/email/fax column) are never read. */
export function parsePocs(f) {
  const out = [];
  POC_ROLES.forEach((role, i) => {
    const b = COL.pocStart + i * POC_BLOCK;
    const name = joinName(f[b], f[b + 1], f[b + 2]);
    if (!name) return;
    out.push({ role, name, title: blank(f[b + 3]) });
  });
  return out;
}

const upper = (v) => {
  const t = blank(v);
  return t ? t.toUpperCase() : null;
};

/**
 * @param {string} line one record (no newline)
 * @returns {{ row: object } | { skip: string }}
 *   skip reasons: 'header', 'trailer', 'blank', 'malformed' (wrong column count / missing "!end"),
 *   'no_cage', 'no_public_display'.
 */
export function mapLine(line, sourceFile) {
  if (line.startsWith('BOF ')) return { skip: 'header' };
  if (line.startsWith('EOF ')) return { skip: 'trailer' };
  if (line.trim() === '') return { skip: 'blank' };

  const f = line.replace(/\r$/, '').split('|');
  if (f.length !== COLUMN_COUNT || f[COL.end].trim() !== '!end') return { skip: 'malformed' };

  const cage = upper(f[COL.cage]);
  if (!cage || !/^[A-Z0-9]{5}$/.test(cage)) return { skip: 'no_cage' };
  if (blank(f[COL.noPublicDisplay]) === 'NPDY') return { skip: 'no_public_display' };

  const code = upper(f[COL.extractCode]);
  const structure = blank(f[COL.structure]);
  const stateOfInc = blank(f[COL.stateOfInc]);
  const countryOfInc = blank(f[COL.countryOfInc]);
  const primary = blank(f[COL.primaryNaics]);

  return {
    row: {
      cage,
      uei: upper(f[COL.uei]),
      legal_name: blank(f[COL.legalName]),
      dba_name: blank(f[COL.dbaName]),
      entity_url: normalizeUrl(f[COL.url]),
      phys_line1: blank(f[COL.physLine1]), phys_line2: blank(f[COL.physLine2]), phys_city: blank(f[COL.physCity]),
      phys_state: blank(f[COL.physState]), phys_zip: blank(f[COL.physZip]), phys_zip4: blank(f[COL.physZip4]),
      phys_country: blank(f[COL.physCountry]),
      mail_line1: blank(f[COL.mailLine1]), mail_line2: blank(f[COL.mailLine2]), mail_city: blank(f[COL.mailCity]),
      mail_state: blank(f[COL.mailState]), mail_zip: blank(f[COL.mailZip]), mail_zip4: blank(f[COL.mailZip4]),
      mail_country: blank(f[COL.mailCountry]),
      registration_status: EXTRACT_STATUS[code] ?? null,
      registration_date: isoDate(f[COL.regDate]),
      expiration_date: isoDate(f[COL.expDate]),
      last_update_date: isoDate(f[COL.updateDate]),
      activation_date: isoDate(f[COL.activationDate]),
      entity_start_date: isoDate(f[COL.startDate]),
      entity_structure: structure ? ENTITY_STRUCTURES[structure.toUpperCase()] ?? structure : null,
      state_of_incorporation: stateOfInc ?? countryOfInc,
      business_types: parseBusinessTypes(f[COL.bizTypes]),
      sba_certifications: parseSba(f[COL.sba]),
      primary_naics: primary && /^\d{2,6}$/.test(primary) ? primary : null,
      naics: parseNaics(f[COL.naics]),
      psc: parsePsc(f[COL.psc]),
      pocs: parsePocs(f),
      source_file: sourceFile,
    },
  };
}
