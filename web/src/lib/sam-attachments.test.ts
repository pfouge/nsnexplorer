import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_LINKS, MAX_ATTACHMENTS, attachmentLabel, cleanSamLink, publicNoticeUrl, fileTypeLabel, filesText, isSamHost, parseSamAttachments, pickSamAttachments,
} from './sam-attachments.ts';

const FILE = 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/b74dff59617b459fbfc6462042b34523/download';

test('isSamHost: sam.gov and its subdomains only', () => {
  assert.equal(isSamHost('sam.gov'), true);
  assert.equal(isSamHost('API.SAM.GOV'), true);
  assert.equal(isSamHost('notsam.gov'), false);
  assert.equal(isSamHost('sam.gov.evil.example'), false);
});

test('cleanSamLink: a plain SAM.gov file link is kept as it is', () => {
  assert.equal(cleanSamLink(FILE), FILE);
});

test('cleanSamLink: empty and "null" api_key or token parameters are dropped', () => {
  assert.equal(cleanSamLink(`${FILE}?api_key=null&token=`), FILE);
  assert.equal(cleanSamLink(`${FILE}?token=&api_key=NULL`), FILE);
  assert.equal(cleanSamLink(`${FILE}?a=1&api_key=&b=2`), `${FILE}?a=1&b=2`);
});

test('cleanSamLink: a link that carries an API key or token value is withheld', () => {
  assert.equal(cleanSamLink(`${FILE}?api_key=AbCdEf123`), null);
  assert.equal(cleanSamLink(`${FILE}?API_KEY=AbCdEf123&token=`), null);
  assert.equal(cleanSamLink(`${FILE}?token=abc`), null);
  assert.equal(cleanSamLink(`${FILE}?apikey=abc`), null);
});

test('cleanSamLink: only https on SAM.gov, nothing else', () => {
  assert.equal(cleanSamLink('http://sam.gov/x'), 'https://sam.gov/x');
  assert.equal(cleanSamLink('https://example.com/file.pdf'), null);
  assert.equal(cleanSamLink('https://sam.gov.evil.example/file.pdf'), null);
  assert.equal(cleanSamLink('javascript:alert(1)'), null);
  assert.equal(cleanSamLink('ftp://sam.gov/x'), null);
  assert.equal(cleanSamLink('https://user:pw@sam.gov/x'), null);
  assert.equal(cleanSamLink('not a url'), null);
  assert.equal(cleanSamLink(''), null);
  assert.equal(cleanSamLink(null), null);
  assert.equal(cleanSamLink(42), null);
});

test('cleanSamLink: the fragment is dropped', () => {
  assert.equal(cleanSamLink(`${FILE}#top`), FILE);
});

test('fileTypeLabel: extension first, then MIME type, else null', () => {
  assert.equal(fileTypeLabel('Drawing 12.pdf'), 'PDF');
  assert.equal(fileTypeLabel('SOW.DOCX'), 'DOCX');
  assert.equal(fileTypeLabel('no extension', 'application/pdf'), 'PDF');
  assert.equal(fileTypeLabel(null, 'application/zip'), 'ZIP');
  assert.equal(fileTypeLabel('noext'), null);
  assert.equal(fileTypeLabel(null, 'application/x-unknown'), null);
  assert.equal(fileTypeLabel(undefined), null);
});

test('parseSamAttachments: not an array gives nothing', () => {
  for (const v of [null, undefined, 'x', 3, {}, { 0: FILE }]) assert.deepEqual(parseSamAttachments(v), []);
  assert.deepEqual(parseSamAttachments([]), []);
});

test('parseSamAttachments: bare links are numbered in order, with no name or type', () => {
  const b = 'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/bbb/download';
  assert.deepEqual(parseSamAttachments([FILE, `${b}?api_key=null&token=`]), [
    { position: 1, url: FILE, name: null, type: null },
    { position: 2, url: b, name: null, type: null },
  ]);
});

test('parseSamAttachments: duplicates count once, junk entries are skipped, withheld links keep their place', () => {
  const r = parseSamAttachments([FILE, FILE, 7, null, '', `${FILE}2?api_key=SECRET`, 'https://example.com/a.pdf']);
  assert.deepEqual(r.map((a) => [a.position, a.url]), [[1, FILE], [2, null], [3, null]]);
});

test('parseSamAttachments: objects with a url and a name give a name and a type', () => {
  const r = parseSamAttachments([{ url: FILE, name: 'SOW - Lift Replacement_V1.docx' }, { link: `${FILE}b`, name: 'Drawing', mimeType: 'application/pdf' }]);
  assert.deepEqual(r.map((a) => [a.name, a.type]), [['SOW - Lift Replacement_V1.docx', 'DOCX'], ['Drawing', 'PDF']]);
});

test('a long notice: every file is counted, at most MAX_ATTACHMENTS are listed', () => {
  const many = Array.from({ length: MAX_ATTACHMENTS + 25 }, (_, i) => `https://sam.gov/f/${i}/download`);
  assert.equal(parseSamAttachments(many).length, MAX_ATTACHMENTS + 25);
  const view = pickSamAttachments({ source: 'sam_gov', solNumber: 'X', sourceUrl: 'https://sam.gov/opp/abc/view', resourceLinks: many }, null);
  assert.equal(view?.total, MAX_ATTACHMENTS + 25);
  assert.equal(view?.items.length, MAX_ATTACHMENTS);
});

test('attachmentLabel and filesText', () => {
  assert.equal(attachmentLabel({ position: 3, url: FILE, name: null, type: null }), 'Attachment 3');
  assert.equal(attachmentLabel({ position: 3, url: FILE, name: 'Spec.pdf', type: 'PDF' }), 'Spec.pdf');
  assert.equal(filesText(1), '1 file');
  assert.equal(filesText(0), '0 files');
  assert.equal(filesText(1200), '1,200 files');
});

const samSelf = (links: unknown) => ({ source: 'sam_gov', solNumber: 'SPE9Z126T0001', sourceUrl: 'https://sam.gov/opp/a/view', resourceLinks: links });
const dibbsSelf = { source: 'dibbs_rfq', solNumber: 'SPE9Z1-26-T-0001', sourceUrl: 'https://www.dibbs.bsm.dla.mil/x', resourceLinks: null };

test('pickSamAttachments: the notice of a SAM.gov page', () => {
  const v = pickSamAttachments(samSelf([FILE, `${FILE}x?api_key=KEY`]), null)!;
  assert.equal(v.from, 'own');
  assert.equal(v.noticeNumber, 'SPE9Z126T0001');
  assert.equal(v.total, 2);
  assert.equal(DIRECT_LINKS ? v.items.length : 0, v.items.length);
  assert.deepEqual(v.items.map((a) => a.url), [FILE]);
});

test('pickSamAttachments: a DIBBS page shows the SAM.gov twin; a SAM.gov twin of a SAM page is not used', () => {
  const v = pickSamAttachments(dibbsSelf, samSelf([FILE]))!;
  assert.equal(v.from, 'twin');
  assert.equal(v.noticeUrl, 'https://sam.gov/opp/a/view');
  assert.equal(pickSamAttachments(dibbsSelf, dibbsSelf), null);
  assert.equal(pickSamAttachments(dibbsSelf, null), null);
  // a SAM page with its own links wins over any twin
  assert.equal(pickSamAttachments(samSelf([FILE]), { ...dibbsSelf })!.from, 'own');
});

test('pickSamAttachments: no links, or only a null list, shows nothing', () => {
  assert.equal(pickSamAttachments(samSelf(null), null), null);
  assert.equal(pickSamAttachments(samSelf([]), null), null);
  assert.equal(pickSamAttachments(dibbsSelf, samSelf(null)), null);
});

test('pickSamAttachments: a notice whose every link is withheld still reports its count', () => {
  const v = pickSamAttachments(samSelf([`${FILE}?api_key=KEY`, `${FILE}2?token=T`]), null)!;
  assert.equal(v.total, 2);
  assert.deepEqual(v.items, []);
});

test('no rendered link ever contains a key parameter', () => {
  const v = pickSamAttachments(samSelf([`${FILE}?api_key=null&token=`, `${FILE}2?api_key=ABC123`]), null)!;
  for (const a of v.items) assert.doesNotMatch(a.url!, /api_?key|token/i);
});

test('publicNoticeUrl: the workspace form becomes the public form, anything else stays', () => {
  assert.equal(publicNoticeUrl('https://sam.gov/workspace/contract/opp/5b345bbb7127b91a3ad577b203fc6f68/view'), 'https://sam.gov/opp/5b345bbb7127b91a3ad577b203fc6f68/view');
  assert.equal(publicNoticeUrl('https://sam.gov/opp/abc/view'), 'https://sam.gov/opp/abc/view');
  assert.equal(publicNoticeUrl('https://example.com/workspace/contract/opp/abc/view'), 'https://example.com/workspace/contract/opp/abc/view');
});

test('pickSamAttachments: the notice link is the public form', () => {
  const v = pickSamAttachments({ ...samSelf([FILE]), sourceUrl: 'https://sam.gov/workspace/contract/opp/abc123/view' }, null)!;
  assert.equal(v.noticeUrl, 'https://sam.gov/opp/abc123/view');
});
