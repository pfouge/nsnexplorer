import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNTS_ENABLED, ACTIONS, MAX_CARD_ITEMS, clearCookie, isAccountPath, itemPath, normKey, readCookie, safeReturnPath, sameOrigin, setCookie,
} from './account.ts';
import { isConfigured, readConfig } from './account-config.ts';
import { filtersFromBar, parseSearchKey, searchKey, searchLabel } from './saved-search.ts';
import { CSV_HEADERS, changeCount, countdown, eventText, headline, itemHref, itemName, watchCsv, type FeedItem, type NsnCard } from './watch-text.ts';

test('the master switch is off in the committed source', () => {
  assert.equal(ACCOUNTS_ENABLED, false);
});

test('account paths are never cached', () => {
  for (const p of ['/auth/login', '/auth/callback', '/auth/logout', '/api/me', '/api/account/feed', '/api/account']) assert.ok(isAccountPath(p), p);
  for (const p of ['/api/lookup.json', '/api/nsn/5340-00-123-4567.json', '/nsn/5340-00-123-4567/', '/authors/', '/api/meta']) assert.ok(!isAccountPath(p), p);
});

test('keys are normalized the way watch_norm() in the migration does', () => {
  assert.equal(normKey('nsn', '5340-00-123-4567'), '5340001234567');
  assert.equal(normKey('nsn', ' 5340001234567 '), '5340001234567');
  assert.equal(normKey('nsn', '53400012345'), null);
  assert.equal(normKey('supplier', '1abc2'), '1ABC2');
  assert.equal(normKey('manufacturer', 'toolong'), null);
  assert.equal(normKey('fsc', '5340'), '5340');
  assert.equal(normKey('fsc', '534'), null);
  assert.equal(normKey('solicitation', 'SPE7M1-26-Q-0042'), 'SPE7M1-26-Q-0042');
  assert.equal(normKey('solicitation', 'has space'), null);
  assert.equal(normKey('agency', 'Defense-Logistics-Agency'), 'defense-logistics-agency');
  assert.equal(normKey('agency', '-bad-'), null);
  assert.equal(normKey('search', 'FSC=5340;Closes=7'), 'fsc=5340;closes=7');
  assert.equal(normKey('search', 'fsc=5340;evil=1'), null);
  assert.equal(normKey('search', 'all'), 'all');
  assert.equal(normKey('nsn', 5340001234567), null);
});

test('item paths point at the pages that show the Follow button', () => {
  assert.equal(itemPath('nsn', '5340001234567'), '/nsn/5340-00-123-4567/');
  assert.equal(itemPath('supplier', '1ABC2'), '/supplier/1ABC2/');
  assert.equal(itemPath('manufacturer', '1ABC2'), '/supplier/1ABC2/');
  assert.equal(itemPath('fsc', '5340'), '/fsc/5340/');
  assert.equal(itemPath('solicitation', 'SPE7M1-26-Q-0042'), '/solicitation/SPE7M1-26-Q-0042/');
  assert.equal(itemPath('agency', 'dla'), '/agency/dla/');
  assert.equal(itemPath('search', 'all'), '/open/');
  assert.equal(itemPath('search', 'fsc=5340;closes=7'), '/open/5340/#search=fsc=5340;closes=7');
});

test('return paths stay on the site', () => {
  assert.equal(safeReturnPath('/nsn/5340-00-123-4567/'), '/nsn/5340-00-123-4567/');
  for (const bad of ['https://evil.example/', '//evil.example', '/\\evil', 'javascript:alert(1)', '/auth/login', '/api/me', '', null, undefined, '/a\nb']) {
    assert.equal(safeReturnPath(bad as string | null | undefined), '/watchlist/', String(bad));
  }
});

test('POSTs must carry the request\'s own origin', () => {
  assert.ok(sameOrigin('https://nsnexplorer.com', 'https://nsnexplorer.com/api/account/follow'));
  assert.ok(!sameOrigin(null, 'https://nsnexplorer.com/x'));
  assert.ok(!sameOrigin('https://evil.example', 'https://nsnexplorer.com/x'));
  assert.ok(!sameOrigin('https://www.nsnexplorer.com', 'https://nsnexplorer.com/x'));
  assert.ok(!sameOrigin('not a url', 'https://nsnexplorer.com/x'));
});

test('cookies are Secure, SameSite=Lax and HttpOnly unless the page must read them', () => {
  const c = setCookie('nsn_session', 'a b', { maxAge: 100 });
  assert.match(c, /Secure; SameSite=Lax; HttpOnly$/);
  assert.doesNotMatch(setCookie('nsn_signed_in', '1', { maxAge: 100, httpOnly: false }), /HttpOnly/);
  assert.match(clearCookie('nsn_session'), /Max-Age=0/);
  assert.equal(readCookie('x=1; nsn_session=a%20b; y=2', 'nsn_session'), 'a b');
  assert.equal(readCookie('x=1', 'nsn_session'), undefined);
});

test('every account action has a method, one database function and checked arguments', () => {
  const nsn = '5340001234567';
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(ACTIONS.follow.args({ kind: 'nsn', key: '5340-00-123-4567', label: ' Washer ', on: false }), { p_kind: 'nsn', p_key: nsn, p_label: 'Washer', p_on: false, p_list: null });
  assert.equal(ACTIONS.follow.args({ kind: 'planet', key: 'x' }), 'Unknown kind.');
  assert.equal(ACTIONS.follow.args({ kind: 'nsn', key: '12' }), 'Bad key.');
  assert.equal(ACTIONS.follow.args({ kind: 'nsn', key: nsn, list: 'nope' }), 'Bad list.');
  assert.equal(ACTIONS.list.args({}), 'A new list needs a name.');
  assert.deepEqual(ACTIONS.list.args({ id, public: true }), { p_id: id, p_name: null, p_public: true, p_delete: false });
  assert.equal(ACTIONS.move.args({ kind: 'fsc', key: '5340', from: id, to: 'x' }), 'Bad move.');
  assert.deepEqual(ACTIONS.reviewed.args({}), { p_list: null, p_kind: null, p_key: null });
  assert.deepEqual(ACTIONS.reviewed.args({ list: id, kind: 'fsc', key: '5340' }), { p_list: id, p_kind: 'fsc', p_key: '5340' });
  assert.equal(ACTIONS.copy.args({ slug: 'short' }), 'Bad link.');
  assert.equal(ACTIONS.note.args({ list: id, kind: 'fsc', key: '5340', note: 'x'.repeat(900) }) instanceof Object && (ACTIONS.note.args({ list: id, kind: 'fsc', key: '5340', note: 'x'.repeat(900) }) as { p_note: string }).p_note.length, 500);
  assert.equal(ACTIONS.cards.anon, true);
  assert.equal(ACTIONS.follow.anon, undefined);
  assert.equal(ACTIONS.cards.args({ items: Array.from({ length: MAX_CARD_ITEMS + 1 }, () => ({ kind: 'fsc', key: '5340' })) }) , `Ask for at most ${MAX_CARD_ITEMS} items at a time.`);
  assert.deepEqual(ACTIONS.cards.args({ items: [{ kind: 'search', key: 'all', since: '2026-10-01T00:00:00Z' }, { kind: 'fsc', key: '5340', since: 'drop table' }] }),
    { items: [{ kind: 'search', key: 'all', since: '2026-10-01T00:00:00Z' }, { kind: 'fsc', key: '5340' }] });
  assert.equal(ACTIONS.cards.args({ items: 'x' }), 'Bad items.');
  assert.equal(ACTIONS.feed.method, 'GET');
});

test('config: any missing setting means accounts are not available', () => {
  assert.equal(isConfigured(readConfig(undefined)), false);
  const full = { WORKOS_CLIENT_ID: 'client_x', WORKOS_API_KEY: 'sk_x', WORKOS_COOKIE_PASSWORD: 'x'.repeat(32), SUPABASE_URL: 'https://p.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
  assert.equal(isConfigured(readConfig(full)), true);
  assert.equal(readConfig(full).supabaseUrl, 'https://p.supabase.co');
  assert.equal(isConfigured(readConfig({ ...full, WORKOS_COOKIE_PASSWORD: 'short' })), false);
  assert.equal(isConfigured(readConfig({ ...full, SUPABASE_URL: '' })), false);
  assert.equal(readConfig(full).siteUrl, 'https://nsnexplorer.com');
});

test('saved searches: the stored string, its parse and its label', () => {
  assert.equal(searchKey({}), 'all');
  assert.equal(searchKey({ fsc: '5340', closes: 7, minqty: 1000, comp: 'restricted' }), 'fsc=5340;closes=7;minqty=1000;comp=restricted');
  assert.equal(searchKey({ comp: 'open', fsc: '5340' }), 'fsc=5340;comp=open');
  assert.deepEqual(parseSearchKey('fsc=5340;closes=30'), { fsc: '5340', closes: 30 });
  assert.deepEqual(parseSearchKey('all'), {});
  assert.equal(parseSearchKey('fsc=5340;nope=1'), null);
  assert.equal(parseSearchKey('closes=0'), null);
  const f = { fsc: '5340', closes: 7, comp: 'open' as const };
  assert.deepEqual(parseSearchKey(searchKey(f)), f);
  assert.equal(searchLabel(f, 'Hardware, Commercial'), 'Open demand: Hardware, Commercial (FSC 5340), closing within 7 days, competed');
  assert.equal(searchLabel({}), 'Open demand: all classes');
});

test('saved searches: filters that cannot be mirrored are refused with a reason', () => {
  const bar = { status: 'open', closes: 'any', minqty: 'any', competition: 'all', hasDrawing: false };
  assert.deepEqual(filtersFromBar(bar, '5340'), { filters: { fsc: '5340', closes: null, minqty: null, comp: null } });
  assert.deepEqual(filtersFromBar({ ...bar, closes: '7', minqty: '1000', competition: 'restricted' }, null), { filters: { fsc: null, closes: 7, minqty: 1000, comp: 'restricted' } });
  assert.ok('reason' in filtersFromBar({ ...bar, status: 'closed' }, '5340'));
  assert.ok('reason' in filtersFromBar({ ...bar, status: 'all' }, '5340'));
  assert.ok('reason' in filtersFromBar({ ...bar, hasDrawing: true }, '5340'));
});

const nsnCard: NsnCard = { name: 'WASHER,FLAT', fsc: '5310', fsc_name: 'Nuts and Washers', amc: '2', amsc: null, award_count: 3, prices: [['2026-01-01', 1.5], ['2026-02-01', 1.75]],
  latest: { date: '2026-02-01', unit_price: 1.75, quantity: 100, cage: '1ABC2', supplier: 'ACME', url: 'https://x' }, open_rfqs: 2, next_return_by: '2026-10-20' };

test('card text states only what the records show', () => {
  assert.equal(countdown('2026-10-15', '2026-10-11'), 'returns in 4 days');
  assert.equal(countdown('2026-10-11', '2026-10-11'), 'returns today');
  assert.equal(countdown('2026-10-09', '2026-10-11'), 'returned 2 days ago');
  assert.equal(countdown(null, '2026-10-11'), 'no return-by date');
  const h = headline('nsn', nsnCard, '2026-10-11');
  assert.match(h, /Latest award \$1\.75 each on .*\(ACME\)/);
  assert.match(h, /2 open RFQs, soonest return-by/);
  assert.equal(headline('nsn', undefined, '2026-10-11'), 'No record found for this page.');
  assert.equal(itemName({ kind: 'nsn', key: '5340001234567', label: null }), '5340-00-123-4567');
  assert.equal(itemName({ kind: 'nsn', key: '5340001234567', label: null }, nsnCard), 'WASHER,FLAT');
  assert.equal(itemName({ kind: 'fsc', key: '5340', label: 'Hardware' }), 'Hardware');
  assert.equal(changeCount(1), '1 change');
  assert.equal(changeCount(100), '100 or more changes');
  assert.doesNotMatch(h, /recommend|should|best|buy|bid on/i);
});

test('feed event text', () => {
  const t = eventText('nsn', { type: 'rfq', at: '2026-10-05T00:00:00Z', url: 'https://x', sol: 'SPE-1', nsn: '5340001234567', item: 'WASHER', quantity: 40, return_by: '2026-10-20' } as never);
  assert.match(t, /SPE-1/);
});

test('CSV: one row per item, kind, key, label, URL, headline, changes', () => {
  const feed: FeedItem = { list: 'l', kind: 'nsn', key: '5340001234567', label: 'WASHER', since: '2026-10-01T00:00:00Z', count: 1,
    events: [{ type: 'rfq', at: '2026-10-05T00:00:00Z', url: 'https://x', sol: 'SPE-1', nsn: '5340001234567', item: 'WASHER', quantity: 40, return_by: '2026-10-20' } as never] };
  const csv = watchCsv('https://nsnexplorer.com', [
    { list: 'My watchlist', item: { kind: 'nsn', key: '5340001234567', label: 'WASHER', added_at: '2026-09-01T00:00:00Z' }, card: nsnCard, feed },
    { list: 'My watchlist', item: { kind: 'search', key: 'fsc=5340;closes=7', label: 'Open demand: FSC 5340', note: 'say "hi", ok' } },
  ], '2026-10-11');
  const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], CSV_HEADERS.join(','));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^My watchlist,Part \(NSN\),5340001234567,WASHER,https:\/\/nsnexplorer\.com\/nsn\/5340-00-123-4567\//);
  assert.match(lines[2], /https:\/\/nsnexplorer\.com\/open\/5340\/,/);   // no #search fragment in a CSV link
  assert.match(lines[2], /"say ""hi"", ok"$/);
});

test('a changed solicitation says what differs, from the stored snapshot', () => {
  const t = eventText('solicitation', { type: 'changed', at: '2026-10-05T00:00:00Z', status: 'closed', was_status: 'open', return_by: '2026-10-20', was_return_by: '2026-10-15', quantity: 40, was_quantity: 40 } as never);
  assert.equal(t, 'Status changed from open to closed; return-by changed from Oct 15, 2026 to Oct 20, 2026.');
});

test('a class links to the page that exists for it', () => {
  const fsc = { name: 'Hardware', open_now: 1, posted_7d: 1, weeks: [] };
  assert.equal(itemHref({ kind: 'fsc', key: '5340' }), '/fsc/5340/');
  assert.equal(itemHref({ kind: 'fsc', key: '5340' }, { ...fsc, deep: true, has_open: true }), '/fsc/5340/');
  assert.equal(itemHref({ kind: 'fsc', key: '5342' }, { ...fsc, deep: false, has_open: true }), '/open/5342/');
  assert.equal(itemHref({ kind: 'fsc', key: '5342' }, { ...fsc, deep: false, has_open: false }), '/catalog/');
  assert.equal(itemHref({ kind: 'nsn', key: '5340001234567' }), '/nsn/5340-00-123-4567/');
});
