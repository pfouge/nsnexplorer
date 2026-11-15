// drawings-copy.ts: the words and official links behind the "Drawings and technical data" block on a solicitation page
// and the guide "How to get the drawings for a DLA solicitation".
//
// Rules for this file:
//   * Every statement about how DLA works is tied to an official page listed in OFFICIAL_SOURCES (with the date shown on
//     that page, or null when the page shows none). Where DLA's pages do not say something, the copy does not either, and
//     points at the page.
//   * We never host, copy or cache a drawing or an attachment: links and instructions only.
//   * Plain language, no em dashes, no legal advice.
// No imports except types, so plain `node --test` loads it.

import type { StandardDoc } from './standard-refs.ts';

export type TechDocsKindCopy = 'none' | 'tech_docs' | 'spec_only';

export interface OfficialSource {
  key: string;
  label: string;
  url: string;
  /** Date printed on the page (ISO), null when the page prints none. */
  pageDate: string | null;
  /** What this page establishes, in one sentence (used in the report and the guide's source list). */
  establishes: string;
}

export const OFFICIAL_SOURCES: Record<string, OfficialSource> = {
  tdmtPage: {
    key: 'tdmtPage',
    label: 'DLA: TDMT (Technical Data Management Transformation)',
    url: 'https://www.dla.mil/Working-With-DLA/Applications/Details/Article/4567728/tdmt-technical-data-management-transformation/',
    pageDate: '2026-08-10',
    establishes:
      'TDMT phase one went live on June 22, 2026 and moved procurement technical data from cFolders to TDMT. Outside vendors register in AMPS, need the Okta FastPass app, and must use the same email in AMPS, DIBBS and Okta.',
  },
  ebsResources: {
    key: 'ebsResources',
    label: 'DLA: EBS Supplier Resources (supplier notices)',
    url: 'https://www.dla.mil/Information-Operations/EBS-Supplier-Resources',
    pageDate: null,
    establishes:
      'TDMT replaced cFolders as the place technical documents are kept (the supplier portal calls it "Technical Data Management Tool (formerly known as c-folders)"); TDMT is at tdmt.dla.mil or through the DIBBS home page; AMPS registration and Okta sign-in; export-controlled data also needs a current NIST SP 800-171 assessment posted in SPRS.',
  },
  ampsRegistration: {
    key: 'ampsRegistration',
    label: 'DLA AMPS: new user registration instructions (PDF)',
    url: 'https://amps1.dla.mil/pdfs/New%20User%20Registration.pdf',
    pageDate: null,
    establishes: 'Linked from the EBS Supplier Resources notice as the AMPS registration instructions. Not opened for this guide.',
  },
  enhancedValidation: {
    key: 'enhancedValidation',
    label: 'DLA: Enhanced Validation',
    url: 'https://www.dla.mil/Logistics-Operations/Enhanced-Validation/',
    pageDate: null,
    establishes:
      'Export-controlled DLA technical data needs an approved JCP certification (DD Form 2345), an approved DIBBS account with cFolders enabled, a documented business need, and DLA Enhanced Validation, which includes DLA export-control training and a signed certificate statement. DLA, not the JCP Office, decides access. The page states no fee and no waiting time.',
  },
  jcpPortal: {
    key: 'jcpPortal',
    label: 'DLA: Joint Certification Program portal',
    url: 'https://www.dla.mil/Working-With-DLA/Applications/Details/Article/4563589/joint-certification-program-portal/',
    pageDate: '2026-08-17',
    establishes:
      'JCP applications are made in the portal (paper and emailed forms are no longer accepted); a SAM registration and CAGE code come first; the page states no fee and no processing time.',
  },
  jcpProgram: {
    key: 'jcpProgram',
    label: 'DLA: Joint Certification Program (brochure page)',
    url: 'https://www.dla.mil/Customer-Support/Brochures/Details/Article/3807634/joint-certification-program/',
    pageDate: '2026-05-18',
    establishes:
      'JCP certifies U.S. and Canadian organizations to access unclassified military technical data that is export-controlled, limited to certified organizations with a legitimate need, under DoDD 5230.25 and the Canadian Technical Data Control Regulations. DD Form 2345 is reviewed and certified by the JCP Office. Certification is required before applying for DLA Enhanced Validation.',
  },
  quickSearchBasic: {
    key: 'quickSearchBasic',
    label: 'DLA: Quick Search (basic search in ASSIST)',
    url: 'https://www.dla.mil/Working-With-DLA/Applications/Details/Article/2922816/quick-search-basic-search-in-assist/',
    pageDate: '2022-02-03',
    establishes:
      'Quick Search is a public site for defense and federal specifications and standards; documents cleared for public release can usually be downloaded; some files are access-controlled.',
  },
  dspLocating: {
    key: 'dspLocating',
    label: 'Defense Standardization Program: locating and ordering documents',
    url: 'https://www.dsp.dla.mil/Policy-Guidance/FAQs/Locating-and-Ordering-Documents/',
    pageDate: null,
    establishes:
      'Quick Search needs no registration; for a DoD-adopted non-government standard only the adoption notice may be downloaded.',
  },
  dibbsPocketGuide: {
    key: 'dibbsPocketGuide',
    label: 'DLA: DIBBS pocket guide (PDF, older)',
    url: 'https://www.dla.mil/Portals/104/Documents/SmallBusiness/DIBBS%20Pocket%20Guide.pdf',
    pageDate: null,
    establishes: 'The DIBBS solicitation legend: "There are technical documents available for the NSN." It still describes cFolders.',
  },
  smallBusinessGuide: {
    key: 'smallBusinessGuide',
    label: 'DLA Small Business: Accessing DIBBS and cFolders (PDF, written for cFolders)',
    url: 'https://www.dla.mil/Portals/104/Documents/SmallBusiness/Accessing%20the%20DLA%20Internet%20Bid%20Board%20(DIBBS)%20and%20the%20Collaboration%20Folders%20(cFolders)%20(003).pdf',
    pageDate: null,
    establishes: 'Not read: the file could not be opened from the build sandbox. Listed because the request named it; it predates TDMT.',
  },
  aiaNas: {
    key: 'aiaNas',
    label: 'AIA: Purchase NAS standards',
    url: 'https://aia-aerospace.org/?p=11877',
    pageDate: '2026-10-06',
    establishes: 'AIA offers access to its National Aerospace Standards (NAS), ordered through its standards catalog; its FAQ says NASM and NAM standards are military specifications converted to NAS.',
  },
};

export const SRC = OFFICIAL_SOURCES;
export const DIBBS_HOME_URL = 'https://www.dibbs.bsm.dla.mil/';
export const TDMT_URL = 'https://tdmt.dla.mil/';
export const GUIDE_PATH = '/guides/how-to-get-the-drawings-for-a-dla-solicitation/';
/** Anchor of the block on the solicitation page (the NSN page links here). */
export const DRAWINGS_ANCHOR = 'drawings';
/** Data custodian address printed on DLA's Enhanced Validation page. */
export const DATA_CUSTODIAN_EMAIL = 'DLAJ344DataCustodian@dla.mil';

export interface DrawingsStep {
  text: string;
  /** Official link for the step, or an internal path for our own pages. */
  link?: { href: string; label: string; external: boolean };
}

export interface DrawingsBlock {
  kind: TechDocsKindCopy;
  heading: string;
  /** Short badge text next to the heading. */
  badge: string;
  intro: string;
  steps: DrawingsStep[];
  /** Show the part's standard documents (Feature A) under the steps. */
  showStandards: boolean;
  /** Plain note shown when showStandards is true but no standard document is on file for the part. */
  noStandardsNote: string | null;
  /** Always-shown short warnings, after the steps. */
  notes: string[];
}

const ext = (href: string, label: string) => ({ href, label, external: true });

/** The export-control paragraph shared by the block and the guide. Not legal advice. */
export const EXPORT_CONTROL_NOTES: string[] = [
  'Some technical data is export-controlled. Do not forward it, post it, or send it outside the United States, and share it only with people your DLA approval covers.',
  'DLA\'s Enhanced Validation page says DLA has a responsibility to protect this data and requires export-control training before it grants access. Follow that training for the exact rules.',
];

/**
 * The block for one DIBBS solicitation, or null when there is nothing to say (no recognised flag and no documents).
 * `hasStandardDocs` says whether feature A found a standard document for the part.
 * SAM.gov notices get no block here: their attachments are handled elsewhere (see the marked insertion point on the page).
 */
export function drawingsBlock(kind: TechDocsKindCopy | null, source: string, hasStandardDocs: boolean, sourceUrl: string): DrawingsBlock | null {
  if (source !== 'dibbs_rfq') return null;
  const guide = { href: GUIDE_PATH, label: 'Read the full guide', external: false };
  if (kind === 'tech_docs') {
    return {
      kind,
      heading: 'Drawings and technical data',
      badge: 'DLA lists technical data',
      intro:
        'DLA has marked this solicitation as having technical documents in DIBBS. We do not host or copy them. DLA hands them out through its own system, TDMT, which replaced cFolders.',
      steps: [
        { text: 'Open the official solicitation in DIBBS and read it, including any notes on technical data.', link: ext(sourceUrl, 'Open in DIBBS') },
        {
          text: 'Register in AMPS, DLA\'s Account Management and Provisioning System. DLA says suppliers who need technical data must register there.',
          link: ext(SRC.ampsRegistration.url, 'AMPS registration instructions (DLA PDF)'),
        },
        {
          text: 'Set up Okta. DLA says outside users need the Okta FastPass app to verify their identity, and your email address must match in AMPS, DIBBS and Okta.',
          link: ext(SRC.tdmtPage.url, 'DLA page on TDMT'),
        },
        { text: 'Sign in to TDMT, directly or from the DIBBS home page, and look for this solicitation.', link: ext(TDMT_URL, 'TDMT') },
        {
          text: 'If a document is export-controlled, DLA also requires Joint Certification Program certification (DD Form 2345) and DLA Enhanced Validation. DLA decides who gets access.',
          link: ext(SRC.enhancedValidation.url, 'DLA Enhanced Validation'),
        },
      ],
      showStandards: hasStandardDocs,
      noStandardsNote: null,
      notes: [...EXPORT_CONTROL_NOTES, 'DLA\'s pages do not say how long access takes or whether it costs anything. Start before the solicitation closes.'],
    };
  }
  if (kind === 'spec_only') {
    return {
      kind,
      heading: 'Drawings and technical data',
      badge: 'Specifications and standards',
      intro:
        'DLA marks this solicitation "Tech Docs *Spec/Stnd Only". We read that as: the requirement is defined by specifications and standards, not by a drawing package for this solicitation. Check the solicitation text to confirm.',
      steps: [
        { text: 'Open the official solicitation in DIBBS and note which specifications or standards it cites.', link: ext(sourceUrl, 'Open in DIBBS') },
        {
          text: hasStandardDocs
            ? 'Look up the standard documents for this part below. Government documents are searched by document id in ASSIST. Industry standards are bought from the publisher named.'
            : 'No standard document number is on file for this part. Use the document numbers the solicitation cites, and search government ones in ASSIST.',
          link: ext(SRC.quickSearchBasic.url, 'About ASSIST Quick Search'),
        },
      ],
      showStandards: true,
      noStandardsNote: hasStandardDocs ? null : 'No standard document number is on file for this part in the federal catalog data we use.',
      notes: [],
    };
  }
  if (kind === 'none') {
    return {
      kind,
      heading: 'Drawings and technical data',
      badge: 'None listed',
      intro:
        'DLA lists no technical data for this solicitation. The flag does not say why, so read the solicitation text for how the item is described, such as a part number or named sources.',
      steps: [
        { text: 'Open the official solicitation in DIBBS and read how the item is described.', link: ext(sourceUrl, 'Open in DIBBS') },
        { text: 'If you think a drawing should exist, ask the buyer named on the solicitation.', link: guide },
      ],
      showStandards: hasStandardDocs,
      noStandardsNote: null,
      notes: [],
    };
  }
  if (hasStandardDocs) {
    return {
      kind: 'spec_only',
      heading: 'Drawings and technical data',
      badge: 'Standard documents',
      intro: 'DLA gives no technical data flag for this solicitation. The federal catalog cites standard documents for the part.',
      steps: [{ text: 'Open the official solicitation in DIBBS and read it.', link: ext(sourceUrl, 'Open in DIBBS') }],
      showStandards: true,
      noStandardsNote: null,
      notes: [],
    };
  }
  return null;
}

/** One line on the part page when an open solicitation of the part carries Tech Docs, or null. */
export function techDocsLineForPart(
  sols: { solNumber: string; status: string; techDocs: TechDocsKindCopy | null }[]
): { text: string; solNumber: string; count: number } | null {
  const open = sols.filter((s) => s.status === 'open' && s.techDocs === 'tech_docs');
  if (open.length === 0) return null;
  const first = open[0];
  const text =
    open.length === 1
      ? `DLA lists technical data for open solicitation ${first.solNumber}.`
      : `DLA lists technical data for ${open.length} open solicitations of this part, such as ${first.solNumber}.`;
  return { text, solNumber: first.solNumber, count: open.length };
}

/** Counts a list of standard docs by access class, for headings and chips. */
export function standardDocCounts(docs: Pick<StandardDoc, 'access'>[]): { assist: number; sold: number } {
  return { assist: docs.filter((d) => d.access !== 'sold').length, sold: docs.filter((d) => d.access === 'sold').length };
}
