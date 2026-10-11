import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aboutMode, addressLines, allRanks, changeSentence, longDate, mailHref, rankBadges, registrationBadge, samEntityUrl, sameAddress, siteDomain, telHref,
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
  assert.equal(samEntityUrl('j7k3m9p2q4r5'), 'https://sam.gov/entity/J7K3M9P2Q4R5/coreData');
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
  risingDelta: null, refreshedAt: '2026-10-11T00:00:00Z', ...o,
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
