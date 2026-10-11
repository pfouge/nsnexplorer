#!/usr/bin/env node
// End-to-end check of accounts and watchlists on a local build: the real Pages Function
// (`wrangler pages dev` on a web/dist built with PUBLIC_ACCOUNTS_FORCE=1) against local fakes of
// WorkOS and Supabase's REST endpoint (web/scripts/accounts-fakes.mjs) and a throwaway local
// Postgres made by web/scripts/accounts-db-prepare.mjs.
//
//   PUBLIC_ACCOUNTS_FORCE=1 DATABASE_URL=<local url> npm run build --workspace=web
//   node web/scripts/accounts-db-prepare.mjs <local url> gpx_e2e
//   node web/scripts/verify-accounts-e2e.mjs postgresql://root:gpxlocal@127.0.0.1:5432/gpx_e2e [dist-dir]
//
// Needs Playwright (PLAYWRIGHT_BROWSERS_PATH for the browsers; the module is found on the normal
// path or in /opt/npm-tools). It inserts rows into pub.* and deletes accounts, so it only runs on
// a throwaway local copy. Never point it at production.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { startFakes } from "./accounts-fakes.mjs";

const dbUrl = process.argv[2];
if (!dbUrl || !/(127\.0\.0\.1|localhost)/.test(dbUrl)) { console.error("usage: node web/scripts/verify-accounts-e2e.mjs <local-database-url> [dist-dir]"); process.exit(2); }
const webDir = new URL("../", import.meta.url).pathname;
const distDir = resolve(process.argv[3] ?? `${webDir}dist`);
if (!existsSync(`${distDir}/_worker.js`)) { console.error(`no _worker.js in ${distDir}; build web first`); process.exit(2); }
const PORT = Number(process.env.E2E_PORT ?? 8788), BASE = `http://localhost:${PORT}`;
const A = { id: "user_e2e_A00000000000000001", email: "a@example.test" };
const B = { id: "user_e2e_B00000000000000002", email: "b@example.test" };
const SHOTS = process.env.E2E_SHOTS;   // directory: also save a few screenshots

let failed = 0, ran = 0;
const ok = (cond, label, extra = "") => { ran++; if (!cond) { failed++; console.log("  x", label, extra); } else if (process.env.VERBOSE) console.log("  ok", label); };

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const [stub] = await sql`select (select count(*) from pg_namespace where nspname = 'auth') as auth`;
if (Number(stub.auth) !== 1) { console.error("this database has no Supabase stand-ins; run web/scripts/accounts-db-prepare.mjs first"); process.exit(2); }
await sql`delete from accounts where id in (${A.id}, ${B.id})`;

// ── fixtures: real records, so every page and card has something to show ───────────────────
const dashed = (n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9)}`;
const [nsnRow] = await sql`select n.nsn::text as nsn, n.fsc::text as fsc from pub.nsns n
  where exists (select 1 from pub.solicitations s where s.nsn = n.nsn and s.status = 'open' and (s.return_by is null or s.return_by >= current_date))
    and exists (select 1 from pub.price_points p where p.nsn = n.nsn and p.cage is not null)
    and exists (select 1 from pub.fsc f where f.fsc = n.fsc and f.render_depth = 'deep')
  order by (select count(*) from pub.price_points p where p.nsn = n.nsn) desc limit 1`;
const [award] = await sql`select cage::text as cage, agency_id from pub.price_points where nsn = ${nsnRow.nsn} and cage is not null order by awarded_on desc limit 1`;
const [openSol] = await sql`select sol_number from pub.solicitations where nsn = ${nsnRow.nsn} and status = 'open' order by sol_number limit 1`;
const agencies = (await sql`select a.agency_id, agency_slug(a.name) as slug, a.name from pub.agencies a where exists (select 1 from pub.price_points p where p.agency_id = a.agency_id) order by a.agency_id`);
const agency = agencies.find((a) => existsSync(`${distDir}/agency/${a.slug}/index.html`));
if (!nsnRow || !award || !openSol || !agency) { console.error("this database lacks the NSN, supplier, solicitation or agency the checks need"); process.exit(2); }
const FSC = nsnRow.fsc, CAGE = award.cage, SOL = openSol.sol_number, NSN = nsnRow.nsn, AG = agency.slug;
await sql`delete from pub.part_numbers where part_number = 'E2E-PN-1'`;
await sql`insert into pub.part_numbers (nsn, part_number, cage, source, source_url) values (${NSN}, 'E2E-PN-1', ${CAGE}, 'test', 'https://x/pn')`;
const cleanupRows = async () => {
  await sql`delete from pub.part_numbers where part_number = 'E2E-PN-1'`;
  await sql`delete from pub.solicitations where sol_number like 'E2E-TEST-%'`;
  await sql`delete from accounts where id in (${A.id}, ${B.id})`;
};

const fakes = await startFakes({ dbUrl });
const vars = {
  WORKOS_CLIENT_ID: "client_test", WORKOS_API_KEY: "sk_test_fake", WORKOS_COOKIE_PASSWORD: "x".repeat(40),
  SUPABASE_URL: "http://localhost:8702", SUPABASE_PUBLISHABLE_KEY: "anon-test-key", WORKOS_API_HOSTNAME: "localhost:8701", SITE_URL: BASE,
  DATABASE_URL: dbUrl,
};
// Settings go in web/.dev.vars (wrangler's --binding flag cuts values at the first colon, which
// breaks every URL). The file is deleted again on the way out.
const devVars = `${webDir}.dev.vars`;
writeFileSync(devVars, Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
const wr = spawn("npx", ["--yes", "wrangler@4", "pages", "dev", distDir, "--compatibility-flags", "nodejs_compat", "--port", String(PORT), "--ip", "127.0.0.1"],
  { cwd: webDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
let wlog = ""; wr.stdout.on("data", (d) => (wlog += d)); wr.stderr.on("data", (d) => (wlog += d));
const cleanup = async () => { try { process.kill(-wr.pid, "SIGKILL"); } catch { wr.kill("SIGKILL"); } rmSync(devVars, { force: true }); await fakes.close(); await cleanupRows().catch(() => {}); await sql.end(); };

let chromium;
try { ({ chromium } = await import("playwright")); } catch { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); }
let browser;
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} pageerror ${e}`));
  // B is the page that makes the deliberate refused requests and visits the unshared link (4xx is expected there).
  // The sandbox has no outside network: failed loads of Google Tag Manager and the like are not ours
  page.on("console", (m) => { if (m.type() === "error" && !(tag === "B" && /status of 4\d\d/.test(m.text())) && !/Failed to load resource: net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_)/.test(m.text())) errors.push(`${tag} console ${m.text()}`); });
};
const settle = (p) => p.waitForLoadState("networkidle").catch(() => {});
const pressed = (p, sel) => p.locator(sel).first().getAttribute("aria-pressed");
const waitPressed = (p, sel, v = "true") => p.waitForFunction(([s, want]) => document.querySelector(s)?.getAttribute("aria-pressed") === want, [sel, v], { timeout: 15000 }).catch(() => {});

try {
  // ready = three healthy answers in a row (the first requests after start can fail)
  for (let i = 0, good = 0; i < 150 && good < 3; i++) {
    try { const r = await fetch(`${BASE}/api/me`); good = r.status === 200 ? good + 1 : 0; } catch { good = 0; }
    await sleep(1000);
  }

  // ── API guards, no browser ──
  let r = await fetch(`${BASE}/api/me`); let j = await r.json();
  ok(r.status === 200 && j.signedIn === false && j.available === true, "GET /api/me signed out", JSON.stringify(j));
  ok((r.headers.get("cache-control") ?? "").includes("no-store"), "/api/me is never cached");
  const post = (path, init = {}) => fetch(`${BASE}${path}`, { method: "POST", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  r = await post("/api/account/follow", { body: "{}" });
  ok(r.status === 403, "POST without Origin is refused", r.status);
  r = await post("/api/account/follow", { body: "{}", headers: { Origin: "https://evil.example" } });
  ok(r.status === 403, "POST from another site is refused", r.status);
  r = await post("/api/account/follow", { body: JSON.stringify({ kind: "nsn", key: NSN }), headers: { Origin: BASE } });
  ok(r.status === 401, "follow while signed out is 401", r.status);
  ok((r.headers.get("cache-control") ?? "").includes("no-store"), "account API answers are never cached");
  r = await fetch(`${BASE}/api/account/nope`); ok(r.status === 404 || r.status === 401, "unknown action is refused", r.status);
  r = await post("/api/account/cards", { body: JSON.stringify({ items: [{ kind: "nsn", key: NSN }, { kind: "fsc", key: FSC }] }), headers: { Origin: BASE } });
  j = await r.json().catch(() => ({}));
  ok(r.status === 200 && j[`nsn:${NSN}`] && j[`fsc:${FSC}`], "cards need no sign-in (shared lists use them)", `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  r = await post("/api/account/cards", { body: JSON.stringify({ items: Array.from({ length: 201 }, () => ({ kind: "fsc", key: FSC })) }), headers: { Origin: BASE } });
  ok(r.status === 400, "more than 200 cards in one call is refused", r.status);
  r = await fetch(`${BASE}/api/account/public?slug=aaaaaaaaaaaa`); ok(r.status === 404, "an unknown shared list is a 404", r.status);
  r = await fetch(`${BASE}/auth/login?return=https://evil.example/`, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  ok(r.status === 302 && loc.startsWith("http://localhost:8701/user_management/authorize"), "login redirects to WorkOS", loc);
  ok((r.headers.get("cache-control") ?? "").includes("no-store"), "/auth/login is never cached");
  const st = new URL(loc).searchParams.get("state") ?? "";
  ok(Buffer.from(st.split(".")[1] ?? "", "base64").toString() === "/watchlist/", "an outside return address becomes /watchlist/");
  r = await fetch(`${BASE}/auth/callback?code=x&state=${encodeURIComponent(st)}`, { redirect: "manual" });
  ok(r.status === 302 && (r.headers.get("location") ?? "").includes("signin=expired"), "callback without the state cookie is refused");
  r = await fetch(`${BASE}/auth/logout`, { redirect: "manual" });
  ok(r.status === 404 || r.status === 405, "sign-out by GET is not possible", r.status);
  r = await post("/auth/logout", { body: "{}" });
  ok(r.status === 403, "sign-out from another site is refused", r.status);
  r = await fetch(`${BASE}/nsn/${dashed(NSN)}/`);
  const nsnHtml = await r.text();
  ok(r.status === 200 && nsnHtml.includes("data-follow"), "NSN page is served with a Follow button", r.status);
  ok(!/\bnsn_session\b/.test(r.headers.get("set-cookie") ?? ""), "an anonymous page view sets no account cookie");
  ok((r.headers.get("content-security-policy") ?? "").includes("form-action 'self' https://api.workos.com"), "CSP lets the sign-out form reach WorkOS");
  r = await fetch(`${BASE}/watchlist/`); const wlHtml = await r.text();
  ok(r.status === 200 && wlHtml.includes("data-wl-signed-out") && wlHtml.includes("noindex"), "/watchlist/ is a noindex shell");
  const rpcBefore = fakes.rpcCalls.length;

  // ── the browser ──
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctxA.newPage(); watch(page, "A");
  fakes.setNextUser(A);
  await page.goto(`${BASE}/nsn/${dashed(NSN)}/`, { waitUntil: "load" }); await settle(page);
  ok(!(await page.locator("#acctBtn").isHidden()), "the header watchlist button shows for a signed-out visitor");
  ok(fakes.rpcCalls.length === rpcBefore, "a signed-out page view makes no account call (nothing reaches Supabase)");
  const follow = page.locator("[data-follow][data-kind=nsn]").first();
  ok(await follow.isVisible(), "Follow button shows for a signed-out visitor");
  await follow.click();
  await page.waitForURL(`${BASE}/nsn/${dashed(NSN)}/`, { timeout: 20000 }).catch(() => {});
  await waitPressed(page, "[data-follow][data-kind=nsn]");
  ok(await pressed(page, "[data-follow][data-kind=nsn]") === "true", "after signing in, the NSN is followed");
  const cookies = await ctxA.cookies(BASE);
  const sess = cookies.find((c) => c.name === "nsn_session");
  ok(sess && sess.httpOnly && sess.sameSite === "Lax", "session cookie is HttpOnly and SameSite=Lax");
  ok(cookies.some((c) => c.name === "nsn_signed_in" && !c.httpOnly), "signed-in flag cookie is readable by scripts");
  ok(!(await page.evaluate(() => document.cookie)).includes("nsn_session"), "page scripts cannot read the session cookie");
  ok((await sql`select count(*)::int as n from accounts where id = ${A.id}`)[0].n === 1, "the account row was made on first sign-in");

  // supplier page: both toggles
  await page.goto(`${BASE}/supplier/${CAGE}/`, { waitUntil: "load" }); await settle(page);
  ok(await page.locator("[data-follow][data-kind=supplier]").isVisible() && await page.locator("[data-follow][data-kind=manufacturer]").isVisible(), "the supplier page shows both Follow toggles");
  await page.locator("[data-follow][data-kind=supplier]").click(); await waitPressed(page, "[data-follow][data-kind=supplier]");
  await page.locator("[data-follow][data-kind=manufacturer]").click(); await waitPressed(page, "[data-follow][data-kind=manufacturer]");
  ok(await pressed(page, "[data-follow][data-kind=supplier]") === "true" && await pressed(page, "[data-follow][data-kind=manufacturer]") === "true", "supplier and manufacturer follow independently");
  // the rest of the kinds
  for (const [path, kind] of [[`/solicitation/${encodeURIComponent(SOL)}/`, "solicitation"], [`/agency/${AG}/`, "agency"], [`/fsc/${FSC}/`, "fsc"]]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "load" }); await settle(page);
    const b = page.locator(`[data-follow][data-kind=${kind}]`).first();
    ok(await b.isVisible(), `Follow button on the ${kind} page`, path);
    await b.click(); await waitPressed(page, `[data-follow][data-kind=${kind}]`);
    ok(await pressed(page, `[data-follow][data-kind=${kind}]`) === "true", `${kind} followed`);
  }
  // saved search with a filter
  await page.goto(`${BASE}/open/${FSC}/`, { waitUntil: "load" }); await settle(page);
  await page.selectOption("#f-closes", "30"); await page.waitForTimeout(600);
  const save = page.locator("[data-save-search]");
  ok(await save.isVisible(), "Save this search shows on the class open-demand page");
  await save.click(); await waitPressed(page, "[data-save-search]");
  ok(await pressed(page, "[data-save-search]") === "true", "the search is saved");
  await page.selectOption("#f-status", "all"); await page.waitForTimeout(600);
  await save.click(); await page.waitForTimeout(500);
  ok(/Only open/.test(await page.locator("#acctToast").innerText().catch(() => "")), "a search that cannot be saved says why");
  await page.selectOption("#f-status", "open"); await page.waitForTimeout(300);
  const kinds = (await sql`select i.kind, i.key from watchlist_items i join watchlists w on w.id = i.list_id where w.account_id = ${A.id} order by 1`);
  ok(["nsn", "supplier", "manufacturer", "solicitation", "agency", "fsc", "search"].every((k) => kinds.some((i) => i.kind === k)), "one item of every kind is stored", kinds.map((i) => i.kind).join(","));
  ok(kinds.some((i) => i.kind === "search" && i.key === `fsc=${FSC.toLowerCase()};closes=30`), "the search is stored as its normalized string", JSON.stringify(kinds.filter((i) => i.kind === "search")));
  // hub: save all
  await page.goto(`${BASE}/open/`, { waitUntil: "load" }); await settle(page);
  ok(await page.locator("[data-save-search]").isVisible(), "Save this search shows on the /open/ hub");

  // feed + badge: make everything "new" by moving added_at back
  await sql`update watchlist_items set added_at = '2000-01-01', reviewed_at = null where list_id in (select id from watchlists where account_id = ${A.id})`;
  await page.goto(`${BASE}/nsn/${dashed(NSN)}/`, { waitUntil: "load" }); await settle(page); await page.waitForTimeout(500);
  ok(!(await page.locator("#acctBtn .acct-badge").isHidden()), "header badge shows items with changes");
  const badge = Number((await page.locator("#acctBtn .acct-badge").innerText()).replace(/\D/g, ""));
  ok(badge >= 3, "the badge counts changed items", String(badge));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-nsn.png` });

  await page.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(page);
  await page.waitForSelector("[data-wl-body] h2", { timeout: 15000 }).catch(() => {});
  const body = await page.locator("[data-wl-body]").innerText().catch(() => "");
  ok(/What changed since you last reviewed \(\d+\)/.test(body), "watchlist page lists what changed", body.slice(0, 160));
  for (const k of ["nsn", "supplier", "manufacturer", "fsc", "solicitation", "agency", "search"]) {
    ok(await page.locator(`.wl-list .wl-row[data-kind=${k}]`).count() === 1, `watchlist has a ${k} row`);
  }
  ok(!/No record found/.test(body), "every row has a card", (body.match(/.{40}No record found/) ?? [""])[0]);
  ok(await page.locator(".wl-list .wl-row svg").count() >= 2, "cards draw charts as inline SVG");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-watchlist.png`, fullPage: true });
  const meCalls = []; page.on("request", (q) => { if (q.url().endsWith("/api/me")) meCalls.push(q.url()); });

  // CSV
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.locator("button", { hasText: "Download CSV" }).first().click()]);
  const csvPath = await dl.path();
  const csv = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const lines = csv.trim().split(/\r?\n/);
  ok(/^nsn-explorer-.*\.csv$/.test(dl.suggestedFilename()), "CSV file name", dl.suggestedFilename());
  ok(lines.length === 8 && /^List,Type,Key/.test(lines[0] ?? ""), "CSV has a header and one row per item", `${lines.length} lines; ${lines[0]}`);
  ok(csv.includes(`${BASE}/nsn/${dashed(NSN)}/`), "CSV rows carry the page URL");

  // review one item, then the whole list
  const firstChange = page.locator(".wl-change").first();
  const changeKey = await firstChange.getAttribute("data-key"), changeKind = await firstChange.getAttribute("data-kind");
  await firstChange.locator("button", { hasText: "Mark reviewed" }).click(); await page.waitForTimeout(1200);
  ok(await page.locator(`.wl-change[data-kind="${changeKind}"][data-key="${changeKey}"]`).count() === 0, "Mark reviewed clears that item's changes");
  ok((await sql`select count(*)::int as n from watchlist_items where kind = ${changeKind} and key = ${changeKey} and reviewed_at is not null and list_id in (select id from watchlists where account_id = ${A.id})`)[0].n === 1, "reviewed_at is stored");
  await page.locator("button", { hasText: "Mark all reviewed" }).first().click(); await page.waitForTimeout(1500);
  ok(await page.locator(".wl-change").count() === 0, "Mark all reviewed clears the section");
  ok(await page.locator("#acctBtn .acct-badge").isHidden(), "the header badge clears");
  // a record the site learns of afterwards shows up as a change again
  await sql`insert into pub.solicitations (sol_number, nsn, fsc, status, source, source_url, raw) values (${"E2E-TEST-" + Date.now()}, ${NSN}, ${FSC}, 'open', 'dibbs_rfq', 'https://x/rfq', '{}')`;
  await page.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(page);
  await page.waitForSelector(".wl-change", { timeout: 15000 }).catch(() => {});
  ok(await page.locator(`.wl-change[data-kind=nsn][data-key="${NSN}"]`).count() === 1, "a new solicitation appears as a change after review");

  // lists: create, move, rename
  await page.locator("#wl-new-name").fill("Second list"); await page.locator(".wl-new-list button").click(); await page.waitForTimeout(1000);
  ok(await page.locator(".wl-tabs .chip", { hasText: "Second list" }).count() === 1, "a new list gets a tab");
  await page.locator(".wl-tabs .chip", { hasText: "My watchlist" }).click(); await page.waitForTimeout(500);
  await page.locator(".wl-row[data-kind=agency] select").selectOption({ label: "Second list" }); await page.waitForTimeout(1000);
  ok((await sql`select count(*)::int as n from watchlist_items i join watchlists w on w.id = i.list_id where w.account_id = ${A.id} and w.name = 'Second list' and i.kind = 'agency'`)[0].n === 1, "an item moves to another list");
  await page.locator(".wl-tabs .chip", { hasText: "Second list" }).click(); await page.waitForTimeout(400);
  await page.locator(".wl-list-head button", { hasText: "Rename" }).click();
  await page.locator(".wl-rename input").fill("Agencies"); await page.locator(".wl-rename button").click(); await page.waitForTimeout(1000);
  ok(await page.locator(".wl-tabs .chip", { hasText: "Agencies" }).count() === 1, "a list is renamed");
  await page.locator(".wl-tabs .chip", { hasText: "My watchlist" }).click(); await page.waitForTimeout(400);

  // share the default list; a signed-out visitor sees it; B copies it after signing in
  await page.locator("button", { hasText: "Share with a link" }).first().click();
  await page.waitForSelector(".wl-share input", { timeout: 10000 }).catch(() => {});
  const shareUrl = await page.locator(".wl-share input").first().inputValue().catch(() => "");
  ok(/\/watchlist\/shared\/#[a-z0-9]{12}$/.test(shareUrl), "sharing gives a link", shareUrl);
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pb = await ctxB.newPage(); watch(pb, "B");
  const bCalls = fakes.rpcCalls.length;
  await pb.goto(shareUrl, { waitUntil: "load" }); await settle(pb);
  await pb.waitForSelector("[data-wl-shared] h2", { timeout: 15000 }).catch(() => {});
  await pb.waitForSelector("[data-wl-shared] .wl-row", { timeout: 15000 }).catch(() => {});
  const shared = await pb.locator("[data-wl-shared]").innerText().catch(() => "");
  ok(shared.includes("My watchlist") && await pb.locator("[data-wl-shared] .wl-row").count() === 6, "a signed-out visitor sees the shared list with cards", `${await pb.locator("[data-wl-shared] .wl-row").count()} rows`);
  ok(!shared.includes(A.email) && !shared.includes(A.id), "shared view shows no email or account id");
  ok(fakes.rpcCalls.slice(bCalls).every((c) => c.role === "anon"), "a shared view reads as anon only");
  if (SHOTS) await pb.screenshot({ path: `${SHOTS}/e2e-shared.png`, fullPage: true });
  fakes.setNextUser(B);
  await pb.locator("button", { hasText: "Copy to my watchlist" }).click();
  await pb.waitForURL(/\/watchlist\/shared\//, { timeout: 20000 }).catch(() => {}); await settle(pb);
  await pb.waitForSelector("button:has-text('Copy to my watchlist')", { timeout: 10000 }).catch(() => {});
  await pb.locator("button", { hasText: "Copy to my watchlist" }).click(); await pb.waitForTimeout(1200);
  const bLists = await sql`select w.name, count(i.*)::int as n from watchlists w left join watchlist_items i on i.list_id = w.id where w.account_id = ${B.id} group by 1`;
  ok(bLists.some((l) => l.name === "Copy of My watchlist" && l.n === 6), "B copied the shared list", JSON.stringify(bLists));

  // B's session cannot read or change A's lists through the API
  const aList = (await sql`select id from watchlists where account_id = ${A.id} and is_default`)[0].id;
  const attempt = (url, payload) => pb.evaluate(async ([u, p]) => (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })).status, [url, payload]);
  ok(await attempt("/api/account/list", { id: aList, name: "hijacked" }) >= 400, "B cannot rename A's list through the API");
  ok(await attempt("/api/account/list", { id: aList, delete: true }) >= 400, "B cannot delete A's list through the API");
  ok(await attempt("/api/account/follow", { kind: "fsc", key: FSC, list: aList }) >= 400, "B cannot add to A's list through the API");
  const aReviewed = async () => (await sql`select count(*)::int as n from watchlist_items i join watchlists w on w.id = i.list_id where w.account_id = ${A.id} and i.reviewed_at is not null`)[0].n;
  const reviewedBefore = await aReviewed();
  await attempt("/api/account/reviewed", { list: aList });
  ok(await aReviewed() === reviewedBefore, "B cannot mark A's items reviewed");
  ok((await sql`select name, is_public from watchlists where id = ${aList}`)[0].name === "My watchlist", "A's list is unchanged");
  const bFeed = await pb.evaluate(async () => (await fetch("/api/account/feed")).json());
  ok(JSON.stringify(bFeed).indexOf(A.id) === -1, "B's feed holds nothing of A's");

  // an expired access token is refreshed from the session cookie
  fakes.setAccessTtl(3); fakes.setNextUser(A);
  const ctxC = await browser.newContext(); const pc = await ctxC.newPage(); watch(pc, "C");
  await pc.goto(`${BASE}/auth/login?return=/watchlist/`, { waitUntil: "load" }); await settle(pc);
  fakes.setAccessTtl(300);
  await sleep(4500);   // the 3-second access token in this session's cookie has now expired
  const me = await pc.evaluate(async () => (await fetch("/api/me")).json());
  ok(me.signedIn === true, "an expired access token is refreshed", JSON.stringify(me).slice(0, 120));
  ok((await ctxC.cookies(BASE)).some((c) => c.name === "nsn_session"), "refresh keeps a session cookie");
  ok(fakes.log.includes("POST /user_management/authenticate"), "the refresh went to WorkOS");

  // two requests that both find the access token expired: WorkOS refresh tokens are single-use,
  // so one refresh fails. That failure must not sign the visitor out.
  fakes.setAccessTtl(3); fakes.setNextUser(A);
  const ctxD = await browser.newContext(); const pd = await ctxD.newPage(); watch(pd, "D");
  await pd.goto(`${BASE}/auth/login?return=/watchlist/`, { waitUntil: "load" }); await settle(pd);
  fakes.setAccessTtl(300);
  await sleep(4500);
  const pair = await pd.evaluate(async () => Promise.all([fetch("/api/me").then((x) => x.json()), fetch("/api/me").then((x) => x.json())]));
  ok(pair.some((m) => m.signedIn === true), "one of two simultaneous refreshes succeeds", JSON.stringify(pair).slice(0, 160));
  const afterPair = await pd.evaluate(async () => (await fetch("/api/me")).json());
  ok(afterPair.signedIn === true, "a failed simultaneous refresh does not sign the visitor out", JSON.stringify(afterPair).slice(0, 120));
  ok((await ctxD.cookies(BASE)).some((c) => c.name === "nsn_signed_in" && c.value === "1"), "the signed-in flag cookie survives");
  const dCalls = [];
  pd.on("request", (q) => { if (q.url().endsWith("/api/me")) dCalls.push(q.url()); });
  await pd.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(pd);
  ok(dCalls.length === 1, "the watchlist page makes one /api/me request", dCalls.length);
  await ctxD.close(); await ctxC.close();

  // unshare: the old link stops working
  await page.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(page);
  await page.locator("button", { hasText: "Stop sharing" }).first().click(); await page.waitForTimeout(1000);
  await pb.goto("about:blank"); await pb.goto(shareUrl, { waitUntil: "load" }); await settle(pb); await pb.waitForTimeout(800);
  ok((await pb.locator("[data-wl-shared]").innerText()).includes("no longer exists"), "an unshared link no longer shows the list");

  // sign out (the logout form redirects to WorkOS, so this context skips the page's CSP; the
  // header itself is asserted above)
  const ctxS = await browser.newContext({ bypassCSP: true });
  await ctxS.addCookies(await ctxA.cookies(BASE));
  const ps = await ctxS.newPage(); watch(ps, "S");
  await ps.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(ps);
  await ps.waitForSelector("button:has-text('Sign out')", { timeout: 15000 }).catch(() => {});
  await Promise.all([ps.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {}), ps.locator("button", { hasText: "Sign out" }).click()]);
  const afterOut = await ctxS.cookies(BASE);
  ok(!afterOut.some((c) => c.name === "nsn_session" && c.value), "signing out clears the session cookie");
  ok(!afterOut.some((c) => c.name === "nsn_signed_in" && c.value), "signing out clears the signed-in flag");
  ok(fakes.log.includes("GET /user_management/sessions/logout"), "signing out also ends the WorkOS session");
  ok((await ps.evaluate(async () => (await fetch("/api/me")).json())).signedIn === false, "after sign-out /api/me says signed out");
  await ctxS.close();

  // delete account (B): typed confirmation
  await pb.goto(`${BASE}/watchlist/`, { waitUntil: "load" }); await settle(pb);
  await pb.waitForSelector("button:has-text('Delete my account')", { timeout: 15000 }).catch(() => {});
  await pb.locator("button", { hasText: "Delete my account" }).first().click();
  ok(await pb.locator(".wl-delete button[type=submit]").isDisabled(), "delete stays disabled until DELETE is typed");
  await pb.locator("#wl-del-confirm").fill("DELETE");
  await Promise.all([pb.waitForURL(/account=deleted/, { timeout: 15000 }).catch(() => {}), pb.locator(".wl-delete button[type=submit]").click()]);
  ok((await sql`select count(*)::int as n from accounts where id = ${B.id}`)[0].n === 0, "deleting the account removes it from the database");
  ok((await sql`select count(*)::int as n from watchlists where account_id = ${B.id}`)[0].n === 0, "deleting the account removes its lists");
  ok(!fakes.users.has(B.id), "deleting the account removes the WorkOS user");
  ok((await sql`select count(*)::int as n from accounts where id = ${A.id}`)[0].n === 1, "the other account is untouched");
  ok(errors.length === 0, "no page errors or console errors", errors.slice(0, 4).join(" | "));
  ok(!fakes.rpcCalls.some((c) => !/^(my_state|account_touch|follow|list_save|item_move|item_note|watch_feed|mark_reviewed|list_copy|account_delete|public_watchlist|watch_cards)$/.test(c.fn)), "only the documented functions were called", [...new Set(fakes.rpcCalls.map((c) => c.fn))].join(","));
  ok(!/Hyperdrive|hyperdrive/.test(wlog.split("\n").filter((l) => /account|auth/.test(l)).join("\n")), "no account route touched Hyperdrive");
} catch (e) {
  failed++; console.log("  x crashed:", e.stack ?? e.message);
  if (process.env.VERBOSE) console.log(wlog.slice(-3000));
} finally {
  await browser?.close();
  await cleanup();
}
if (failed && !process.env.VERBOSE) console.log("(set VERBOSE=1 for passing checks and the wrangler log tail)");
console.log(`${failed ? "FAIL" : "PASS"} ${ran - failed}/${ran} end-to-end account checks passed`);
process.exit(failed ? 1 : 0);
