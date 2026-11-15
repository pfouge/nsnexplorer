import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aboutMode, addressLines, allRanks, changeSentence, loadedClasses, longDate, mailHref, moreClassesText, partClassLabel, partFilterStatus, partsHref, partsRange, partsStatusText, rankBadges, rankTrendSentence, registrationBadge, samEntityUrl, sameAddress, siteDomain, telHref,
} from './supplier-view.ts';
import type { SupplierAddress, SupplierSam, SupplierStats, SupplierWeb } from './supplier-page.ts';

const addr = (o: Partial<SupplierAddress> = {}): SupplierAddress => ({ line1: null, line2: null, city: null, state: null, zip: null, zip4: null, country: null, ...o });

test('address lines: street, city line with state/zip(+4), country only when not USA', () => {
  assert.deepEqual(addressLines(addr({ line1: '1200 Lakeside Pkwy', line2: 'Suite 4', city: 'Cleveland', state: 'OH', zip: '44114', zip4: '2210', country: 'USA' })), [
    '1200 Lakeside Pkwy', 'Suite 4', 'Cleveland, OH 44114-2210',
  ]);
  assert.deepEqual(addressLines(addr({ city: 'London', country: 'GBR' })), ['London', 'GBR']);
  assert.deepEqual(addressLines(addr({ state: 'OH', zip: '44114' })), ['OH 44114']);
  assert.deepEqual(addressLines(null), []);
});

test('sameAddress ignores case, punctuation and ZIP+4; needs both', () => {
  const a = addr({ line1: '88 Refinery Road', city: 'Tulsa', state: 'OK', zip: '74103', zip4: '1111' });
  assert.equal(sameAddress(a, addr({ line1: '88 REFINERY ROAD.', city: 'tulsa', state: 'OK', zip: '74103' })), true);
  assert.equal(sameAddress(a, addr({ line1: 'PO Box 1', city: 'Tulsa', state: 'OK', zip: '74103' })), false);
  assert.equal(sameAddress(a, null), false);
});

test('SAM entity link needs a 12-character UEI', () => {
  assert.equal(samEntityUrl('j7k3m9p2q4r5'), 'https://sam.gov/search/?index=ei&sfm%5BsimpleSearch%5D%5BkeywordRadio%5D=ALL&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bkey%5D=J7K3M9P2Q4R5&sfm%5BsimpleSearch%5D%5BkeywordTags%5D%5B0%5D%5Bvalue%5D=J7K3M9P2Q4R5');
  assert.equal(samEntityUrl('SHORT'), null);
  assert.equal(samEntityUrl(null), null);
  assert.equal(samEntityUrl('J7K3M9P2Q4R5/../x'), null);
});

test('site domain, tel and mailto helpers', () => {
  assert.equal(siteDomain('https://www.acmefasteners.example/contact'), 'acmefasteners.example');
  assert.equal(siteDomain('not a url'), null);
  assert.equal(telHref('(216) 555-0142'), 'tel:+12165550142');
  assert.equal(telHref('(216) 555-0142 ext. 12'), 'tel:+12165550142;ext=12');
  assert.equal(telHref('555'), null);
  assert.equal(mailHref('quotes@acmefasteners.example'), 'mailto:quotes@acmefasteners.example');
  assert.equal(mailHref('x@y'), null);
  assert.equal(mailHref('a b@c.com'), null);
});

const sam = (o: Partial<SupplierSam>): SupplierSam => ({
  uei: null, legalName: null, dbaName: null, entityUrl: null, physical: null, mailing: null, registrationStatus: 'Active', registrationDate: null,
  expirationDate: null, lastUpdateDate: null, activationDate: null, entityStartDate: null, entityStructure: null, stateOfIncorporation: null,
  businessTypes: [], sbaCertifications: [], primaryNaics: null, naics: [], psc: [], pocs: [], sourceFile: null, syncedAt: null, ...o,
});

test('registration badge: active only until the expiry date passes', () => {
  assert.deepEqual(registrationBadge(sam({ expirationDate: '2027-01-01' }), '2026-10-11'), { text: 'SAM active until 2027-01-01', tone: 'green' });
  assert.deepEqual(registrationBadge(sam({ expirationDate: '2026-08-01' }), '2026-10-11'), { text: 'SAM registration expired 2026-08-01', tone: 'amber' });
  assert.deepEqual(registrationBadge(sam({ registrationStatus: 'Inactive', expirationDate: '2027-01-01' }), '2026-10-11'), { text: 'SAM inactive', tone: 'amber' });
  assert.equal(registrationBadge(null, '2026-10-11'), null);
});

const stats = (o: Partial<SupplierStats>): SupplierStats => ({
  awardsAll: 1, dollarsAll: 1, awards12m: 1, dollars12m: 1, awardsPrior12m: 0, dollarsPrior12m: 0, nsns: 1, fscs: 1, agencies: 1, firstAward: '2026-01-01',
  lastAward: '2026-02-01', rankDollars12m: null, rankDollarsAll: null, rankWins12m: null, rankWinsAll: null, rankNsns: null, rankFscs: null, rankRising: null,
  risingDelta: null, awards90d: 0, dollars90d: 0, rankDollars90d: null, rankWins90d: null, rankDollars12mPrev: null, longTermContracts: 0,
  refreshedAt: '2026-10-11T00:00:00Z', ...o,
});

test('rank badges: only ranks on a published list, best first, linking to the list anchor', () => {
  const b = rankBadges(stats({ rankDollars12m: 12, rankWins12m: 3, rankWinsAll: 101, rankRising: 100 }));
  assert.deepEqual(b.map((x) => x.text), ['#3 by awards won, last 12 months', '#12 by award dollars, last 12 months', '#100 among rising suppliers']);
  assert.equal(b[1].href, '/supplier/#dollars-12m');
  assert.deepEqual(rankBadges(null), []);
  assert.equal(allRanks(stats({ rankWinsAll: 101, rankNsns: 4 })).length, 2);
});

test('change sentence', () => {
  assert.equal(changeSentence(0, 0), null);
  assert.match(changeSentence(500, 0)!, /none recorded/);
  assert.equal(changeSentence(150, 100), 'Award dollars rose 50% against the 12 months before.');
  assert.equal(changeSentence(50, 100), 'Award dollars fell 50% against the 12 months before.');
  assert.match(changeSentence(100, 100)!, /about the same/);
});

const web = (o: Partial<SupplierWeb>): SupplierWeb => ({
  url: 'https://x.example/', finalUrl: null, status: 'ok', fetchedAt: '2026-09-21T10:00:00Z', pages: [], summary: null, products: [], capabilities: [], certifications: [],
  founded: null, phone: null, email: null, contactUrl: null, metaDescription: null, model: null, ...o,
});

test('about mode: summary for ok, quoted meta for ok_no_ai, nothing otherwise (robots, unreachable, opted out)', () => {
  assert.equal(aboutMode(web({ summary: 'S', metaDescription: 'M' })), 'summary');
  assert.equal(aboutMode(web({ status: 'ok_no_ai', metaDescription: 'M' })), 'meta');
  assert.equal(aboutMode(web({ status: 'ok', summary: null, metaDescription: 'M' })), 'meta');
  assert.equal(aboutMode(web({ status: 'ok_no_ai' })), 'none');
  assert.equal(aboutMode(web({ status: 'robots_blocked', summary: 'S' })), 'none');
  assert.equal(aboutMode(null), 'none');
  assert.equal(longDate('2026-09-21T10:00:00+00:00'), 'September 21, 2026');
});

test('part class chip label, more-classes text, loaded classes and filter status', () => {
  assert.equal(partClassLabel({ fsc: '5340', name: 'Hardware, Commercial', count: 42 }), '5340 Hardware, Commercial · 42');
  assert.equal(partClassLabel({ fsc: '5340', name: null, count: 1234 }), '5340 · 1,234');
  assert.equal(moreClassesText(12, 12), null);
  assert.equal(moreClassesText(13, 12), '+1 more class');
  assert.equal(moreClassesText(1500, 12), '+1,488 more classes');
  const rows = [{ fsc: '5340' }, { fsc: '5310' }, { fsc: '5340' }];
  assert.deepEqual(loadedClasses(rows), ['5310', '5340']);
  assert.deepEqual(loadedClasses([{ fsc: '5340' }, { fsc: '5340' }]), ['5340']);
  assert.deepEqual(partFilterStatus(rows, 'all'), { shown: 3, text: 'Showing 3 of 3 loaded' });
  assert.deepEqual(partFilterStatus(rows, '5340'), { shown: 2, text: 'Showing 2 of 3 loaded' });
  assert.deepEqual(partFilterStatus(rows, '9999'), { shown: 0, text: 'Showing 0 of 3 loaded' });
});

test('rank trend sentence: up, down, same, new, and nothing without a rank', () => {
  assert.equal(rankTrendSentence(stats({ rankDollars12m: 3, rankDollars12mPrev: 8 })), 'Up 5 places in the 12-month dollar ranking since about 30 days ago.');
  assert.equal(rankTrendSentence(stats({ rankDollars12m: 8, rankDollars12mPrev: 7 })), 'Down 1 place in the 12-month dollar ranking since about 30 days ago.');
  assert.equal(rankTrendSentence(stats({ rankDollars12m: 5, rankDollars12mPrev: 5 })), 'No change in the 12-month dollar ranking since about 30 days ago.');
  assert.match(rankTrendSentence(stats({ rankDollars12m: 5, rankDollars12mPrev: null })) ?? '', /^New in the 12-month dollar ranking/);
  assert.equal(rankTrendSentence(stats({ rankDollars12m: null, rankDollars12mPrev: 5 })), null);
  assert.equal(rankTrendSentence(null), null);
});

test('90-day ranks appear as badges and in the rank list', () => {
  const st = stats({ rankDollars90d: 4, rankWins90d: 120 });
  assert.deepEqual(rankBadges(st).map((b) => [b.text, b.href]), [['#4 by award dollars, last 90 days', '/supplier/#dollars-90d']]);
  assert.deepEqual(allRanks(st), [{ label: 'Award dollars, last 90 days', rank: 4 }, { label: 'Awards won, last 90 days', rank: 120 }]);
});

test('listed parts pager: range, status text and links', () => {
  assert.deepEqual(partsRange(6422, 1, 50, 50), { from: 1, to: 50, pages: 129 });
  assert.deepEqual(partsRange(6422, 129, 50, 22), { from: 6401, to: 6422, pages: 129 });
  assert.deepEqual(partsRange(0, 1, 50, 0), { from: 0, to: 0, pages: 1 });
  assert.equal(partsStatusText({ from: 1, to: 50 }, 6422, null), 'Showing 1 to 50 of 6,422 listed parts');
  assert.equal(partsStatusText({ from: 1, to: 50 }, 3100, '5340'), 'Showing 1 to 50 of 3,100 listed parts in class 5340');
  assert.equal(partsStatusText({ from: 1, to: 1 }, 1, '5340'), 'Showing 1 to 1 of 1 listed part in class 5340');
  assert.equal(partsStatusText({ from: 0, to: 0 }, 0, '5340'), 'No listed parts in class 5340');
  assert.equal(partsStatusText({ from: 0, to: 0 }, 140, '5315'), 'This page is past the end of the 140 listed parts in class 5315');
  assert.equal(partsHref('75Q65', null, 1), '/supplier/75Q65/#sp-parts');
  assert.equal(partsHref('75Q65', '5340', 1), '/supplier/75Q65/?class=5340#sp-parts');
  assert.equal(partsHref('75Q65', '5340', 3), '/supplier/75Q65/?class=5340&pp=3#sp-parts');
  assert.equal(partsHref('75Q65', null, 2), '/supplier/75Q65/?pp=2#sp-parts');
});
