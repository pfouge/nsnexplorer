// sam-attachments.ts: the public attachments a SAM.gov notice carries, as links to the official files.
//
// SAM.gov's Get Opportunities API returns `resourceLinks` (an array of download URLs) on every notice it lists, and
// ingest/sam/load.mjs already stores the whole record in pub.solicitations.raw, so the links are read from there:
// no extra table, no extra API call. We never download, cache or host a file: this module only decides which links
// are safe to show, and the solicitation page shows them as links to SAM.gov.
//
// Safety rules (all tested in sam-attachments.test.ts):
//   - only https links on sam.gov or a sam.gov subdomain are ever rendered;
//   - an `api_key` or `token` parameter that is empty or the word "null" is dropped from the link; one that carries a
//     value is a secret, so that link is withheld (never rendered, never stored by us) and counted instead;
//   - when DIRECT_LINKS is false (the browser test of the sample links failed: see the report) no file link is shown
//     at all; the page sends the reader to the notice on SAM.gov and says how many files it lists.
//
// No imports: node --test loads this file directly, and the on-request loader bundles it for the Workers runtime.

/** Show a link to each file. Set to false to link only the notice's SAM.gov page and print the file count. */
export const DIRECT_LINKS = true;

/** Most links read from one notice (a notice with more is cut here; the notice page on SAM.gov lists them all). */
export const MAX_ATTACHMENTS = 40;

export interface SamAttachment {
  /** 1-based place in the notice's list. */
  position: number;
  /** Clean https link to the file on SAM.gov; null when the link was withheld (see the rules above). */
  url: string | null;
  /** File name when the source gives one (the list call gives bare links, so usually null). */
  name: string | null;
  /** Short file type such as "PDF", when the name or a MIME type says so. */
  type: string | null;
}

export interface SamAttachmentsView {
  /** 'own': the notice of this page. 'twin': the SAM.gov twin of this DIBBS solicitation. */
  from: 'own' | 'twin';
  noticeNumber: string;
  noticeUrl: string;
  /** Files the notice lists (links shown plus links withheld). */
  total: number;
  /** Files with a link we show; empty when DIRECT_LINKS is false. */
  items: SamAttachment[];
}

const SECRET_PARAMS = ['api_key', 'apikey', 'token'];
const EMPTY_VALUES = new Set(['', 'null', 'undefined']);

const MIME_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/zip': 'ZIP',
  'text/plain': 'TXT',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/tiff': 'TIF',
};

/** True for sam.gov and its subdomains. */
export function isSamHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'sam.gov' || h.endsWith('.sam.gov');
}

/**
 * A link ready to show, or null when it must be withheld (not https on sam.gov, unparsable, or carrying a secret
 * parameter). Empty or "null" api_key/token parameters are removed; the fragment is dropped.
 */
export function cleanSamLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol === 'http:' && isSamHost(u.hostname)) u.protocol = 'https:';
  if (u.protocol !== 'https:' || !isSamHost(u.hostname) || u.username !== '' || u.password !== '') return null;
  const drop: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (!SECRET_PARAMS.includes(k.toLowerCase())) continue;
    if (!EMPTY_VALUES.has(v.trim().toLowerCase())) return null;
    drop.push(k);
  }
  for (const k of new Set(drop)) u.searchParams.delete(k);
  u.hash = '';
  return u.toString();
}

/** Short type label: from the file name's extension, else from a MIME type; null when neither says. */
export function fileTypeLabel(name: unknown, mime?: unknown): string | null {
  if (typeof name === 'string') {
    const m = name.trim().match(/\.([A-Za-z0-9]{1,5})$/);
    if (m) return m[1].toUpperCase();
  }
  if (typeof mime === 'string') {
    const known = MIME_TYPES[mime.trim().toLowerCase()];
    if (known) return known;
  }
  return null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);

/**
 * Reads the stored `resourceLinks` value. Real records hold an array of URL strings (or null); an entry that is an
 * object with a url/link/href and optionally a name and type is read as well, so file names show if SAM.gov adds
 * them. Anything else is ignored. Duplicate links count once; at most MAX_ATTACHMENTS entries are read.
 */
export function parseSamAttachments(value: unknown): SamAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: SamAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (out.length >= MAX_ATTACHMENTS) break;
    let raw: unknown = entry;
    let name: string | null = null;
    let type: string | null = null;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const o = entry as Record<string, unknown>;
      raw = o.url ?? o.link ?? o.href;
      name = text(o.name ?? o.fileName ?? o.filename);
      type = fileTypeLabel(name, o.mimeType ?? o.type);
    } else if (typeof entry !== 'string') {
      continue;
    }
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const url = cleanSamLink(raw);
    if (url !== null) {
      if (seen.has(url)) continue;
      seen.add(url);
    }
    out.push({ position: out.length + 1, url, name, type });
  }
  return out;
}

/**
 * The public page of a notice. SAM.gov's own `uiLink` has the form https://sam.gov/workspace/contract/opp/<id>/view,
 * which may ask for a sign-in; https://sam.gov/opp/<id>/view is the public form built from the same id. Any other
 * link is returned as it is.
 */
export function publicNoticeUrl(url: string): string {
  const m = url.match(/^https:\/\/(?:www\.)?sam\.gov\/workspace\/contract\/opp\/([0-9A-Za-z]+)\/view(?:[?#].*)?$/);
  return m ? `https://sam.gov/opp/${m[1]}/view` : url;
}

export interface SamNoticeLinks {
  source: string;
  solNumber: string;
  sourceUrl: string;
  /** The stored `resourceLinks` value of a SAM.gov notice (anything for other sources, ignored). */
  resourceLinks: unknown;
}

/**
 * What the page shows: the attachments of this page's own SAM.gov notice, or, on a DIBBS page, those of its SAM.gov
 * twin (sol-twin.ts). Null when there is no SAM.gov notice or it lists no file.
 */
export function pickSamAttachments(self: SamNoticeLinks, twin: SamNoticeLinks | null): SamAttachmentsView | null {
  const notice = self.source === 'sam_gov' ? self : twin && twin.source === 'sam_gov' ? twin : null;
  if (!notice) return null;
  const all = parseSamAttachments(notice.resourceLinks);
  if (all.length === 0) return null;
  return {
    from: notice === self ? 'own' : 'twin',
    noticeNumber: notice.solNumber,
    noticeUrl: publicNoticeUrl(notice.sourceUrl),
    total: all.length,
    items: DIRECT_LINKS ? all.filter((a) => a.url !== null) : [],
  };
}

/** "1 file" or "3 files". */
export const filesText = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`;

/** Link text: the file name, or "Attachment 3" when SAM.gov gave none. */
export const attachmentLabel = (a: SamAttachment): string => a.name ?? `Attachment ${a.position}`;
