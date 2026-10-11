#!/usr/bin/env node
// Checks the accounts layer (db/migrations/0009_accounts_watchlists.sql) against a LOCAL database
// that has it applied (web/scripts/accounts-db-prepare.mjs makes one). Every call is made the way
// PostgREST makes it: as role `anon` or `authenticated` with the token's claims in
// request.jwt.claims, so row-level security and function grants are what is tested, not the
// superuser's view.
//
//   node web/scripts/accounts-db-prepare.mjs postgresql://root:gpxlocal@127.0.0.1:5432/gpx_w_entity gpx_acct
//   node web/scripts/verify-accounts-db.mjs  postgresql://root:gpxlocal@127.0.0.1:5432/gpx_acct
//
// It inserts and changes rows in pub.* to prove what the feed reports as new, so it must only ever
// run against a throwaway copy. It refuses a hosted database and one without the Supabase stubs.

import postgres from "postgres";

const url = process.argv[2] ?? process.env.ACCOUNTS_TEST_DATABASE_URL;
if (!url) { console.error("usage: node web/scripts/verify-accounts-db.mjs <local-database-url>"); process.exit(2); }
if (!/(127\.0\.0\.1|localhost)/.test(url)) { console.error("refusing to run against a database that is not local"); process.exit(2); }
const sql = postgres(url, { max: 1, onnotice: () => {} });

const A = "user_test_A0000000000000001", B = "user_test_B0000000000000002";
let failed = 0, ran = 0;
const ok = (cond, label, extra = "") => { ran++; if (!cond) { failed++; console.log("  x", label, extra); } else if (process.env.VERBOSE) console.log("  ok", label); };

// Run one statement as a PostgREST role with a token for `sub` (or none = anon).
async function as(sub, text, params = []) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${sub ? "authenticated" : "anon"}`);
    await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role: "authenticated" } : { role: "anon" })]);
    return tx.unsafe(text, params);
  });
}
const rpc = async (sub, fn, args = {}) => {
  const keys = Object.keys(args);
  const call = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  return (await as(sub, call, keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? sql.json(args[k]) : args[k]))))[0].r;
};
const fails = async (fn) => { try { await fn(); return false; } catch { return true; } };
const failsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };
const item = (state, kind, key) => state.lists.flatMap((l) => l.items).find((i) => i.kind === kind && i.key === key);
const feedItem = (feed, kind, key) => feed.items.find((i) => i.kind === kind && i.key === key);
const types = (fi) => (fi ? fi.events.map((e) => e.type).sort().join(",") : "");

// the stubs must be there, or the grants below would be tested against nothing
const [stub] = await sql`select (select count(*) from pg_namespace where nspname = 'auth') as auth, (select count(*) from pg_roles where rolname in ('anon','authenticated')) as roles`;
if (Number(stub.auth) !== 1 || Number(stub.roles) !== 2) { console.error("this database has no Supabase stand-ins; run web/scripts/accounts-db-prepare.mjs first"); process.exit(2); }

await sql`delete from accounts where id in (${A}, ${B})`;

// ── fixtures: real records from the database, and a few we add ─────────────────────────────
const [nsnRow] = await sql`select n.nsn::text as nsn, n.fsc::text as fsc from pub.nsns n
  where exists (select 1 from pub.solicitations s where s.nsn = n.nsn and s.status = 'open')
    and exists (select 1 from pub.price_points p where p.nsn = n.nsn) order by n.nsn limit 1`;
const [supRow] = await sql`select cage::text as cage from pub.suppliers order by cage limit 1`;
const [openSol] = await sql`select sol_number, nsn::text as nsn, fsc::text as fsc from pub.solicitations where status = 'open' and nsn is not null
  and (return_by is null or return_by >= current_date) order by sol_number limit 1`;
const [agencyRow] = await sql`select agency_id, name from pub.agencies order by agency_id limit 1`;
if (!nsnRow || !supRow || !openSol || !agencyRow) { console.error("this database lacks the NSNs, suppliers, solicitations or agencies the checks need"); process.exit(2); }
const agencySlug = (await sql`select agency_slug(${agencyRow.name}) as s`)[0].s;
const UEI = "UEITESTACCT1";
const MFR = "ZMFR1";   // a manufacturer CAGE we add part numbers for
const cleanupRows = async () => {
  await sql`delete from pub.price_points where award_ref like 'ACCT-TEST-%'`;
  await sql`delete from pub.contract_actions where award_uid like 'ACCT-TEST-%'`;
  await sql`delete from pub.solicitations where sol_number like 'ACCT-TEST-%'`;
  await sql`delete from pub.part_numbers where part_number = 'TEST-PN-1'`;
  await sql`delete from pub.suppliers where cage = ${MFR}`;
};
await cleanupRows();
await sql`update pub.suppliers set uei = ${UEI} where cage = ${supRow.cage}`;
await sql`insert into pub.suppliers (cage, name) values (${MFR}, 'Test Manufacturer Co')`;
await sql`insert into pub.part_numbers (nsn, part_number, cage, source, source_url) values (${nsnRow.nsn}, 'TEST-PN-1', ${MFR}, 'test', 'https://x/pn')`;

try {
  // 1. anonymous visitors ─────────────────────────────────────────────────────────────────
  ok(await fails(() => rpc(null, "my_state")), "anon cannot call my_state");
  ok(await fails(() => as(null, "select * from watchlists")), "anon cannot read watchlists");
  ok(await fails(() => as(null, "select * from accounts")), "anon cannot read accounts");
  ok(await fails(() => as(null, "select * from watchlist_items")), "anon cannot read watchlist_items");
  ok(await fails(() => rpc(null, "follow", { p_kind: "nsn", p_key: nsnRow.nsn })), "anon cannot follow");
  ok(await fails(() => rpc(null, "watch_feed")), "anon cannot read a feed");
  ok(await fails(() => rpc(null, "mark_reviewed")), "anon cannot mark reviewed");
  ok(await fails(() => rpc(null, "search_matches", { params: {} })), "anon cannot run a saved search");
  ok(await fails(() => rpc(null, "account_delete")), "anon cannot delete an account");
  ok(await fails(() => as(null, "select * from pub.price_points limit 1")), "anon cannot read pub tables directly");
  ok(await fails(() => as(null, "select * from pub.solicitations limit 1")), "anon cannot read solicitations directly");
  const anonCards = await rpc(null, "watch_cards", { items: [{ kind: "nsn", key: nsnRow.nsn }] });
  ok(anonCards[`nsn:${nsnRow.nsn}`], "anon can read cards (public records, for shared lists)");
  ok(await fails(() => rpc(null, "watch_cards", { items: Array.from({ length: 201 }, () => ({ kind: "fsc", key: "5340" })) })), "cards refuse more than 200 items");
  ok(JSON.stringify(await rpc(null, "watch_cards", { items: [{ kind: "nsn", key: "nope" }, { kind: "bogus", key: "x" }] })) === "{}", "cards skip items they cannot read");

  // 2. first sign-in ──────────────────────────────────────────────────────────────────────
  let s = await rpc(A, "account_touch", { p_email: "a@example.com" });
  ok(s.lists.length === 1 && s.lists[0].is_default && s.lists[0].name === "My watchlist", "account_touch makes one default list");
  s = await rpc(A, "account_touch", { p_email: null });
  ok(s.lists.length === 1 && s.account.email === "a@example.com", "account_touch is idempotent and keeps the email");
  ok(s.new_count === 0, "a new account has nothing changed");

  // 3. every kind follows and unfollows, keys normalized ─────────────────────────────────
  const dashed = `${nsnRow.nsn.slice(0, 4)}-${nsnRow.nsn.slice(4, 6)}-${nsnRow.nsn.slice(6, 9)}-${nsnRow.nsn.slice(9)}`;
  const searchKey = `fsc=${nsnRow.fsc};closes=30;minqty=1;comp=open`;
  const kinds = [
    ["nsn", dashed, nsnRow.nsn], ["supplier", supRow.cage.toLowerCase(), supRow.cage], ["manufacturer", MFR.toLowerCase(), MFR],
    ["fsc", nsnRow.fsc, nsnRow.fsc], ["solicitation", openSol.sol_number, openSol.sol_number], ["agency", ` ${agencySlug.toUpperCase()} `, agencySlug],
    ["search", "COMP=open;minqty=1;closes=30;fsc=" + nsnRow.fsc, searchKey],
  ];
  const aList = s.lists[0].id;
  for (const [kind, input, stored] of kinds) {
    s = await rpc(A, "follow", { p_kind: kind, p_key: input, p_label: `Label ${kind}` });
    ok(item(s, kind, stored)?.label === `Label ${kind}`, `follow ${kind}: key stored as ${stored}`);
    s = await rpc(A, "follow", { p_kind: kind, p_key: stored, p_label: null });
    ok(s.lists[0].items.filter((i) => i.kind === kind).length === 1 && item(s, kind, stored).label === `Label ${kind}`, `follow ${kind} twice keeps one item and its label`);
  }
  const bad = [["nsn", "123"], ["supplier", "TOOLONG"], ["manufacturer", "a b"], ["fsc", "5"], ["solicitation", "has space"], ["agency", "-x-"], ["search", "fsc=5331;evil=1"], ["planet", "mars"], ["nsn", "<script>"]];
  for (const [kind, key] of bad) ok(await fails(() => rpc(A, "follow", { p_kind: kind, p_key: key })), `follow refuses ${kind} "${key}"`);
  ok(item(await rpc(A, "my_state"), "search", "all") === undefined, "no stray search item exists");
  s = await rpc(A, "follow", { p_kind: "search", p_key: "ALL" });
  ok(item(s, "search", "all"), "an empty saved search is 'all'");
  for (const [kind, , stored] of [...kinds, ["search", "", "all"]]) {
    s = await rpc(A, "follow", { p_kind: kind, p_key: stored, p_on: false });
    ok(!item(s, kind, stored), `unfollow ${kind}`);
  }
  ok(s.lists[0].items.length === 0, "all seven kinds unfollowed leaves an empty list");

  // 4. another user sees nothing of A and cannot write into A's lists ────────────────────
  s = await rpc(A, "follow", { p_kind: "nsn", p_key: nsnRow.nsn, p_label: "Mine" });
  await rpc(B, "account_touch", { p_email: "b@example.com" });
  ok((await as(B, "select * from watchlists where account_id = $1", [A])).length === 0, "B cannot read A's watchlists");
  ok((await as(B, "select * from watchlist_items where list_id = $1", [aList])).length === 0, "B cannot read A's items");
  ok((await as(B, "select * from accounts where id = $1", [A])).length === 0, "B cannot read A's account");
  ok(await fails(() => rpc(B, "follow", { p_kind: "nsn", p_key: nsnRow.nsn, p_list: aList })), "B cannot follow into A's list");
  ok(await fails(() => rpc(B, "list_save", { p_id: aList, p_name: "hijacked" })), "B cannot rename A's list");
  ok(await fails(() => rpc(B, "mark_reviewed", { p_list: aList })), "B cannot mark A's list reviewed");
  ok(await fails(() => rpc(B, "item_note", { p_list: aList, p_kind: "nsn", p_key: nsnRow.nsn, p_note: "x" })), "B cannot write a note on A's item");
  ok(await fails(() => as(B, "update watchlists set name = 'x' where id = $1 returning id", [aList]).then((r) => { if (!r.length) throw new Error("no rows"); })), "B cannot update A's list directly");
  ok(await fails(() => as(B, "insert into watchlists (account_id, name) values ($1, 'x')", [A])), "B cannot create a list for A");
  ok(await fails(() => as(B, "insert into watchlist_items (list_id, kind, key) values ($1, 'nsn', '1234567890123')", [aList])), "B cannot insert an item into A's list");
  ok((await rpc(B, "watch_feed")).items.length === 0, "B's feed is B's own");

  // 5. what is new: nothing before a new record; each kind reports its own; review clears ───
  await rpc(A, "follow", { p_kind: "supplier", p_key: supRow.cage });
  await rpc(A, "follow", { p_kind: "manufacturer", p_key: MFR });
  await rpc(A, "follow", { p_kind: "fsc", p_key: nsnRow.fsc });
  await rpc(A, "follow", { p_kind: "solicitation", p_key: openSol.sol_number });
  await rpc(A, "follow", { p_kind: "agency", p_key: agencySlug });
  await rpc(A, "follow", { p_kind: "search", p_key: `fsc=${nsnRow.fsc};minqty=1` });
  s = await rpc(A, "my_state");
  let feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(s.new_count === 0 && feed.items.length === 0, "records the site already had are not new");
  ok((await sql`select snap is not null as has from watchlist_items where kind = 'solicitation' and key = ${openSol.sol_number} limit 1`)[0].has, "following a solicitation keeps a snapshot");

  // the site "learns" of: an RFQ for the NSN, an award for it by the supplier / agency / solicitation, a contract action
  await sql`insert into pub.solicitations (sol_number, nsn, fsc, quantity, issued_on, return_by, status, source, nomenclature, source_url, raw)
            values ('ACCT-TEST-1', ${nsnRow.nsn}, ${nsnRow.fsc}, 500, current_date, current_date + 10, 'open', 'dibbs_rfq', 'TEST ITEM', 'https://x/rfq/1', '{}')`;
  await sql`insert into pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, sol_number, award_ref, source, source_url, raw)
            values (${nsnRow.nsn}, current_date, 12.5, 4, 50, ${supRow.cage}, ${agencyRow.agency_id}, ${openSol.sol_number}, 'ACCT-TEST-AW1', 'dibbs_award', 'https://x/aw/1', '{}')`;
  await sql`insert into pub.contract_actions (award_uid, action_date, obligation, agency_id, recipient_name, recipient_uei, source_url, raw)
            values ('ACCT-TEST-CA1', current_date, 1000, ${agencyRow.agency_id}, 'Test Recipient', ${UEI}, 'https://x/ca/1', '{}')`;
  s = await rpc(A, "my_state");
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(types(feedItem(feed, "nsn", nsnRow.nsn)) === "award,rfq", "nsn: a new RFQ and a new award for the part", types(feedItem(feed, "nsn", nsnRow.nsn)));
  ok(types(feedItem(feed, "supplier", supRow.cage)) === "award,contract_action", "supplier: a new award and a new contract action", types(feedItem(feed, "supplier", supRow.cage)));
  ok(types(feedItem(feed, "manufacturer", MFR)) === "rfq", "manufacturer: a new RFQ for a part it makes", types(feedItem(feed, "manufacturer", MFR)));
  ok(types(feedItem(feed, "fsc", nsnRow.fsc)) === "award,rfq", "fsc: a new RFQ and a new award in the class", types(feedItem(feed, "fsc", nsnRow.fsc)));
  ok(types(feedItem(feed, "solicitation", openSol.sol_number)) === "award", "solicitation: an award posted for it", types(feedItem(feed, "solicitation", openSol.sol_number)));
  ok(types(feedItem(feed, "agency", agencySlug)) === "award,contract_action", "agency: a new contract action and a new award", types(feedItem(feed, "agency", agencySlug)));
  ok(types(feedItem(feed, "search", `fsc=${nsnRow.fsc};minqty=1`)) === "rfq", "search: a new RFQ matching the saved filters", types(feedItem(feed, "search", `fsc=${nsnRow.fsc};minqty=1`)));
  ok(s.new_count === 7 && feed.changed === 7, "the badge counts changed items", `${s.new_count}/${feed.changed}`);
  const supEv = feedItem(feed, "supplier", supRow.cage).events;
  ok(supEv.every((e) => typeof e.url === "string" && e.url.startsWith("https://")) && supEv.every((e, i) => i === 0 || supEv[i - 1].at >= e.at), "events carry their source link and are newest first");

  // an NSN item added now only sees records that arrive later
  const [nsnTwo] = await sql`select n.nsn::text as nsn from pub.nsns n where n.nsn <> ${nsnRow.nsn} and exists (select 1 from pub.price_points p where p.nsn = n.nsn) order by n.nsn limit 1`;
  await rpc(A, "follow", { p_kind: "nsn", p_key: nsnTwo.nsn });
  await sql`insert into pub.price_points (nsn, awarded_on, unit_price, quantity, cage, award_ref, source, source_url, raw)
            values (${nsnTwo.nsn}, current_date, 7, 1, ${supRow.cage}, 'ACCT-TEST-AW2', 'dibbs_award', 'https://x/aw/2', '{}')`;
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(types(feedItem(feed, "nsn", nsnTwo.nsn)) === "award", "nsn: a new award appears after the follow");

  // a solicitation's status and return-by: a change is a difference from the snapshot, never updated_at alone
  await sql`update pub.solicitations set updated_at = now(), last_seen_at = now() where sol_number = ${openSol.sol_number}`;
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(!types(feedItem(feed, "solicitation", openSol.sol_number)).includes("changed"), "re-crawling a solicitation without a change is not a change");
  const was = (await sql`select return_by from pub.solicitations where sol_number = ${openSol.sol_number}`)[0].return_by;
  await sql`update pub.solicitations set return_by = coalesce(return_by, current_date) + 5, updated_at = now() where sol_number = ${openSol.sol_number}`;
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  const chg = feedItem(feed, "solicitation", openSol.sol_number)?.events.find((e) => e.type === "changed");
  ok(chg && chg.return_by !== chg.was_return_by, "a new return-by date is reported with the old one", JSON.stringify(chg));
  await sql`update pub.solicitations set status = 'cancelled', updated_at = now() where sol_number = ${openSol.sol_number}`;
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(feedItem(feed, "solicitation", openSol.sol_number)?.events.find((e) => e.type === "changed")?.status === "cancelled", "a status change is reported");

  // review: one item, then the rest
  s = await rpc(A, "mark_reviewed", { p_list: aList, p_kind: "supplier", p_key: supRow.cage });
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(!feedItem(feed, "supplier", supRow.cage) && feedItem(feed, "fsc", nsnRow.fsc), "mark reviewed clears only that item");
  ok(item(s, "supplier", supRow.cage).reviewed_at && !item(s, "fsc", nsnRow.fsc).reviewed_at, "reviewed_at is set on the one item");
  ok(await fails(() => rpc(A, "mark_reviewed", { p_list: aList, p_kind: "supplier" })), "naming a kind without a key is refused");
  s = await rpc(A, "mark_reviewed", { p_list: aList });
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(s.new_count === 0 && feed.items.length === 0, "marking the list reviewed clears everything");
  await sql`insert into pub.contract_actions (award_uid, action_date, obligation, agency_id, recipient_name, recipient_uei, source_url, raw)
            values ('ACCT-TEST-CA2', current_date, 5, ${agencyRow.agency_id}, 'Test Recipient', ${UEI}, 'https://x/ca/2', '{}')`;
  feed = await rpc(A, "watch_feed", { p_per: 8 });
  ok(types(feedItem(feed, "supplier", supRow.cage)) === "contract_action" && types(feedItem(feed, "agency", agencySlug)) === "contract_action", "after review only newer records appear");
  ok(feedItem(feed, "solicitation", openSol.sol_number) === undefined, "a reviewed solicitation is compared with its new snapshot");
  await rpc(A, "mark_reviewed");   // every list
  ok((await rpc(A, "watch_feed")).items.length === 0, "mark reviewed with no list covers every list of mine");
  // the cap
  for (let i = 0; i < 12; i++) await sql`insert into pub.contract_actions (award_uid, action_date, obligation, agency_id, recipient_uei, source_url, raw) values (${"ACCT-TEST-CAX" + i}, current_date, 1, ${agencyRow.agency_id}, ${UEI}, 'https://x/ca/x', '{}')`;
  feed = await rpc(A, "watch_feed", { p_per: 5 });
  const capped = feedItem(feed, "supplier", supRow.cage);
  ok(capped.events.length === 5 && capped.count === 12, "events are capped per item but the count is the whole", `${capped.events.length}/${capped.count}`);
  await rpc(A, "mark_reviewed");

  // 6. sharing, notes, copy ───────────────────────────────────────────────────────────────
  s = await rpc(A, "item_note", { p_list: aList, p_kind: "nsn", p_key: nsnRow.nsn, p_note: "secret note for me" });
  ok(item(s, "nsn", nsnRow.nsn).note === "secret note for me", "a note is kept on the item");
  s = await rpc(A, "list_save", { p_id: aList, p_public: true });
  const slug = s.lists[0].slug;
  ok(/^[a-z0-9]{12}$/.test(slug ?? ""), "sharing makes a 12-character slug");
  const pub = await rpc(null, "public_watchlist", { p_slug: slug });
  ok(pub && pub.items.length >= 7, "anyone can view a shared list");
  const pubText = JSON.stringify(pub);
  ok(!pubText.includes(A) && !pubText.includes("example.com") && !pubText.includes("secret note") && !/reviewed_at|added_at/.test(pubText), "shared view carries no account id, email, note or review state");
  const copy = await rpc(B, "list_copy", { p_slug: slug });
  const copied = copy.lists.find((l) => l.name.startsWith("Copy of"));
  ok(copied && copied.items.length === pub.items.length && copied.items.every((i) => !i.note && !i.reviewed_at), "B can copy a shared list (items only, no notes)");
  ok(copy.new_count === 0, "a copy starts with nothing changed");
  s = await rpc(A, "list_save", { p_id: aList, p_public: false });
  ok(s.lists[0].slug === null && (await rpc(null, "public_watchlist", { p_slug: slug })) === null, "unsharing kills the old link");
  ok(await fails(() => rpc(B, "list_copy", { p_slug: slug })), "an unshared list cannot be copied");
  ok((await rpc(null, "public_watchlist", { p_slug: "aaaaaaaaaaaa" })) === null, "an unknown link shows nothing");

  // 7. lists: create, rename, move, delete; the default stays ─────────────────────────────
  s = await rpc(A, "list_save", { p_name: "Banks" });
  const banks = s.lists.find((l) => l.name === "Banks").id;
  s = await rpc(A, "item_move", { p_kind: "fsc", p_key: nsnRow.fsc, p_from: aList, p_to: banks });
  ok(s.lists.find((l) => l.id === banks).items.length === 1 && !s.lists.find((l) => l.id === aList).items.some((i) => i.kind === "fsc"), "move an item between lists");
  ok(item(s, "fsc", nsnRow.fsc).reviewed_at, "a moved item keeps its review state");
  const stranger = (await sql`select gen_random_uuid() as u`)[0].u;
  ok(await fails(() => rpc(A, "item_move", { p_kind: "fsc", p_key: nsnRow.fsc, p_from: banks, p_to: stranger })), "cannot move to a list that is not mine");
  ok(await fails(() => rpc(A, "list_save", { p_id: aList, p_delete: true })), "the default list cannot be deleted");
  s = await rpc(A, "list_save", { p_id: banks, p_name: "Renamed" });
  ok(s.lists.some((l) => l.name === "Renamed"), "rename a list");
  s = await rpc(A, "list_save", { p_id: banks, p_delete: true });
  ok(s.lists.length === 1, "delete a list");
  ok(await fails(() => rpc(A, "list_save", { p_name: "x".repeat(81) })), "a list name over 80 characters is refused");

  // 8. limits ───────────────────────────────────────────────────────────────────────────────
  let limitHit = false;
  for (let i = 0; i < 21 && !limitHit; i++) { try { await rpc(A, "list_save", { p_name: `L${i}` }); } catch (e) { limitHit = /up to 20/.test(e.message); } }
  ok(limitHit, "no more than 20 lists");
  const lim = (await rpc(B, "my_state")).lists[0].id;
  await as(B, `insert into watchlist_items (list_id, kind, key) select $1, 'solicitation', 'LIM-' || g from generate_series(1, 500) g`, [lim]);
  ok(await failsWith(() => rpc(B, "follow", { p_kind: "solicitation", p_key: "LIM-501", p_list: lim }), /up to 500/), "no more than 500 items in a list");

  // 9. cards, one per kind ──────────────────────────────────────────────────────────────────
  const items = [
    { kind: "nsn", key: nsnRow.nsn }, { kind: "supplier", key: supRow.cage }, { kind: "manufacturer", key: MFR },
    { kind: "fsc", key: nsnRow.fsc }, { kind: "solicitation", key: openSol.sol_number }, { kind: "agency", key: agencySlug },
    { kind: "search", key: `fsc=${nsnRow.fsc}`, since: "2000-01-01" },
  ];
  const cards = await rpc(A, "watch_cards", { items });
  const c = (k) => cards[k];
  const n = c(`nsn:${nsnRow.nsn}`), su = c(`supplier:${supRow.cage}`), mf = c(`manufacturer:${MFR}`), f = c(`fsc:${nsnRow.fsc}`),
    so = c(`solicitation:${openSol.sol_number}`), ag = c(`agency:${agencySlug}`), se = c(`search:fsc=${nsnRow.fsc}`);
  ok(Object.keys(cards).length === 7, "one card for each of the seven kinds");
  ok(n && n.name && n.fsc === nsnRow.fsc && Array.isArray(n.prices) && n.prices.length <= 12 && n.prices.length >= 1 && n.latest?.unit_price !== undefined && typeof n.open_rfqs === "number" && "amsc" in n, "nsn card: name, class, prices, latest award, open RFQs, coding");
  const priceDates = n.prices.map((p) => p[0]);
  ok(priceDates.every((d, i) => i === 0 || priceDates[i - 1] <= d), "nsn card: prices run oldest to newest");
  ok(su && su.name && su.months.length === 12 && su.months.reduce((a, m) => a + m[1], 0) >= 1 && su.wins.length >= 1 && su.wins.length <= 5, "supplier card: name, 12 months, latest wins");
  ok(mf && mf.part_count === 1 && mf.nsn_count === 1 && mf.open_rfqs >= 1 && mf.rfqs.length >= 1, "manufacturer card: part count, open RFQs, latest RFQs");
  ok(f && f.name && f.weeks.length === 12 && typeof f.open_now === "number" && typeof f.posted_7d === "number", "fsc card: name, open now, posted last 7 days, 12 weeks");
  const [fscRow] = await sql`select render_depth = 'deep' as deep, (render_depth <> 'excluded' and fsc ~ '^[0-9]{4}$' and exists (select 1 from pub.solicitations s where s.fsc = f.fsc)) as has_open from pub.fsc f where fsc = ${nsnRow.fsc}`;
  ok(f && f.deep === fscRow.deep && f.has_open === fscRow.has_open, "fsc card: says which page exists for the class (deep, has_open)", JSON.stringify([f?.deep, f?.has_open, fscRow]));
  ok(so && so.nsn === openSol.nsn && so.status && so.url && "award" in so && "return_by" in so, "solicitation card: NSN, status, dates, award slot");
  const awardedSol = (await sql`select p.sol_number from pub.price_points p where p.sol_number is not null limit 1`)[0];
  if (awardedSol) {
    const ac = await rpc(null, "watch_cards", { items: [{ kind: "solicitation", key: awardedSol.sol_number }] });
    ok(ac[`solicitation:${awardedSol.sol_number}`]?.award?.unit_price !== undefined, "solicitation card: the award shows when one is posted");
  }
  ok(ag && ag.name && ag.actions_90d.count >= 1 && ag.latest.length >= 1 && ag.awards_90d.count >= 1, "agency card: name, 90-day actions and awards, latest actions");
  ok(se && typeof se.open_now === "number" && typeof se.new_since === "number", "search card: open now and new since");
  const direct = (await sql`select count(distinct nsn)::int as n from pub.solicitations where status = 'open' and nsn is not null and (return_by is null or return_by >= current_date) and fsc = ${nsnRow.fsc}`)[0].n;
  ok(se.open_now === direct, "search card: open matches equals a direct count", `${se.open_now} vs ${direct}`);
  ok(se.new_since >= 1, "search card: counts the RFQ added since");

  // 10. saved-search filters, each against a direct query ─────────────────────────────────
  const matches = (p, since = null) => rpc(A, "search_matches", { params: p, since });
  const openBase = `status = 'open' and nsn is not null and (return_by is null or return_by >= current_date)`;
  const all = (await matches({})).open_now;
  ok(all === (await sql.unsafe(`select count(distinct nsn)::int as n from pub.solicitations where ${openBase}`))[0].n, "search: no filter = every open card");
  const byFsc = (await matches({ fsc: nsnRow.fsc })).open_now;
  ok(byFsc === direct && byFsc <= all, "search: class filter");
  const closes7 = (await matches({ closes: 7 })).open_now;
  ok(closes7 === (await sql.unsafe(`select count(*)::int as n from (select nsn, min(return_by) r from pub.solicitations where ${openBase} group by nsn) c where r is not null and r - current_date <= 7`))[0].n, "search: closing-within filter uses the card's earliest return-by");
  const q100 = (await matches({ minqty: 100 })).open_now;
  ok(q100 === (await sql.unsafe(`select count(*)::int as n from (select nsn, sum(coalesce(quantity,0)) q from pub.solicitations where ${openBase} group by nsn) c where q >= 100`))[0].n, "search: minimum-quantity filter uses the card's summed quantity");
  const compOpen = (await matches({ comp: "open" })).open_now, compRes = (await matches({ comp: "restricted" })).open_now;
  const compDirect = async (cond) => (await sql.unsafe(`select count(*)::int as n from (
      select s.nsn from pub.solicitations s
      left join lateral (select amc, amsc from pub.amsc_observations ao where ao.nsn = s.nsn order by observed_on desc limit 1) a on true
      where s.status = 'open' and s.nsn is not null and (s.return_by is null or s.return_by >= current_date) and ${cond}
      group by s.nsn) c`))[0].n;
  ok(compOpen === await compDirect(`(a.amc in ('1','2') or (coalesce(a.amc, '') not in ('3','4','5') and a.amsc = 'G'))`), "search: competed filter follows AMC / AMSC (same rule as the card)");
  ok(compRes === await compDirect(`a.amc in ('3','4','5')`), "search: named-source filter follows AMC");
  const both = (await matches({ fsc: nsnRow.fsc, closes: 30, minqty: 1, comp: "open" })).open_now;
  ok(both <= byFsc && both <= compOpen, "search: filters combine");
  const sinceNow = await matches({ fsc: nsnRow.fsc }, new Date(Date.now() - 3600e3).toISOString());
  ok(sinceNow.new_since >= 1 && sinceNow.new_since <= sinceNow.solicitations, "search: new since counts only newer RFQs");
  ok((await matches({ fsc: nsnRow.fsc }, new Date(Date.now() + 3600e3).toISOString())).new_since === 0, "search: nothing is new since the future");
  ok(await failsWith(() => rpc(A, "follow", { p_kind: "search", p_key: "drawing=1" }), /not valid/), "a filter that cannot be mirrored (drawing) cannot be saved");

  // 11. delete the account ────────────────────────────────────────────────────────────────────
  await rpc(A, "account_delete");
  ok((await sql`select count(*)::int as n from watchlists where account_id = ${A}`)[0].n === 0, "deleting the account deletes its lists");
  ok((await sql`select count(*)::int as n from watchlist_items where list_id = ${aList}`)[0].n === 0, "deleting the account deletes its items");
  ok((await sql`select count(*)::int as n from accounts where id = ${A}`)[0].n === 0, "deleting the account deletes the account row");
  ok((await sql`select count(*)::int as n from accounts where id = ${B}`)[0].n === 1, "B's account is untouched");
} finally {
  await cleanupRows().catch(() => {});
  await sql`update pub.suppliers set uei = null where cage = ${supRow.cage}`.catch(() => {});
  await sql`delete from accounts where id in (${A}, ${B})`.catch(() => {});
  await sql.end();
}
console.log(`${failed ? "FAIL" : "PASS"}: ${ran - failed}/${ran} account and watchlist database checks passed`);
process.exit(failed ? 1 : 0);
