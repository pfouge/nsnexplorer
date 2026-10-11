import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillMonths, mapSam, mapStats, mapWeb, safeHttpUrl } from './supplier-page.ts';

test('fillMonths: 24 calendar months ending with today, zero-filled, across a year boundary', () => {
  const m = fillMonths('2026-02-15', [
    { month: '2026-01', awards: 3, dollars: '120.5' },
    { month: '2024-03', awards: 1, dollars: 10 },
    { month: '2024-02', awards: 9, dollars: 99 }, // 25 months back: outside the window
  ]);
  assert.equal(m.length, 24);
  assert.equal(m[0].month, '2024-03');
  assert.equal(m[23].month, '2026-02');
  assert.deepEqual(m[22], { month: '2026-01', awards: 3, dollars: 120.5 });
  assert.deepEqual(m[0], { month: '2024-03', awards: 1, dollars: 10 });
  assert.equal(m.reduce((a, x) => a + x.awards, 0), 4);
  assert.equal(new Set(m.map((x) => x.month)).size, 24);
});

test('safeHttpUrl keeps http(s) only', () => {
  assert.equal(safeHttpUrl('https://a.example/x'), 'https://a.example/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('ftp://a.example'), null);
  assert.equal(safeHttpUrl('  '), null);
  assert.equal(safeHttpUrl(null), null);
});

test('mapSam: addresses, lists and malformed entries', () => {
  const s = mapSam({
    uei: 'ABC', legal_name: ' ACME ', dba_name: '', entity_url: 'https://a.example', phys_line1: '1 Main', phys_city: 'Dayton', phys_state: 'OH',
    mail_line1: null, mail_city: null, registration_status: 'Active', registration_date: '2026-01-02', expiration_date: null,
    business_types: ['Small Business', ' ', 7], sba_certifications: [{ label: '8(a)', entry: '2021-01-01', exit: null }, { entry: 'x' }, null],
    naics: [{ code: '332722', small: true }, { code: '', small: true }, { code: '423840' }], psc: ['5305'],
    pocs: [{ role: 'Gov', name: 'Jane', title: 'CEO' }, { name: '' }, { role: 'x' }], source_file: 'f.zip', synced_at: '2026-10-01T00:00:00+00:00',
  })!;
  assert.equal(s.legalName, 'ACME');
  assert.equal(s.dbaName, null);
  assert.equal(s.physical?.city, 'Dayton');
  assert.equal(s.mailing, null);
  assert.deepEqual(s.businessTypes, ['Small Business']);
  assert.deepEqual(s.sbaCertifications, [{ label: '8(a)', entry: '2021-01-01', exit: null }]);
  assert.deepEqual(s.naics, [{ code: '332722', small: true }, { code: '423840', small: null }]);
  assert.deepEqual(s.pocs, [{ role: 'Gov', name: 'Jane', title: 'CEO' }]);
  assert.equal(s.registrationDate, '2026-01-02');
  assert.equal(mapSam(null), null);
});

test('mapSam with the contact keys removed by the SQL (opted out) has no addresses or contacts', () => {
  const s = mapSam({ uei: 'ABC', legal_name: 'ACME', registration_status: 'Active', business_types: [], naics: [], sba_certifications: [] })!;
  assert.equal(s.physical, null);
  assert.equal(s.mailing, null);
  assert.deepEqual(s.pocs, []);
});

test('mapWeb: drops non-http links, out-of-range founded years; tolerates stripped profile keys', () => {
  const w = mapWeb({
    url: 'https://a.example', final_url: 'javascript:x', status: 'ok', fetched_at: '2026-09-21T10:00:00+00:00',
    pages: [{ url: 'https://a.example/about', title: 'About' }, { url: 'file:///etc/passwd', title: 'x' }], summary: 'S', products: ['a', ''], founded: 1500,
    phone: '(216) 555-0142', email: 'info@a.example', contact_url: 'mailto:x@y.z',
  })!;
  assert.equal(w.finalUrl, null);
  assert.deepEqual(w.pages, [{ url: 'https://a.example/about', title: 'About' }]);
  assert.deepEqual(w.products, ['a']);
  assert.equal(w.founded, null);
  assert.equal(w.contactUrl, null);
  // hide_web strips the profile keys; the row must still map (contact only)
  const c = mapWeb({ url: 'https://a.example', status: 'ok', fetched_at: '2026-09-21T10:00:00+00:00', phone: '1', email: 'e@a.example', contact_url: 'https://a.example/c' })!;
  assert.equal(c.summary, null);
  assert.deepEqual(c.pages, []);
  assert.equal(mapWeb({ url: 'ftp://a', status: 'ok', fetched_at: 'x' }), null);
  assert.equal(mapWeb(null), null);
});

test('mapStats keeps null ranks null and numbers numeric', () => {
  const s = mapStats({
    awards_all: 5, dollars_all: '1000.50', awards_12m: 3, dollars_12m: '500', awards_prior_12m: 2, dollars_prior_12m: 0, nsns: 4, fscs: 2, agencies: 1,
    first_award: '2025-01-01', last_award: '2026-02-01', rank_dollars_12m: 7, rank_rising: null, rising_delta: '500', refreshed_at: '2026-10-11T00:00:00+00:00',
  })!;
  assert.equal(s.dollarsAll, 1000.5);
  assert.equal(s.rankDollars12m, 7);
  assert.equal(s.rankRising, null);
  assert.equal(s.rankWins12m, null);
  assert.equal(s.risingDelta, 500);
});
