#!/usr/bin/env node
// Screenshots and layout checks of the account UI with the account API answered in the browser
// (Playwright route handlers backed by the local database, so no sign-in service is needed):
//
//   PUBLIC_ACCOUNTS_FORCE=1 DATABASE_URL=<local url> npm run build --workspace=web
//   node web/scripts/accounts-db-prepare.mjs <local url> gpx_e2e
//   node web/scripts/accounts-shots.mjs postgresql://root:gpxlocal@127.0.0.1:5432/gpx_e2e <dist-dir> <out-dir>
//
// Pages shot, at desktop 1280 light and phone 390 dark: an NSN page (Follow), the supplier page
// (both toggles), the header with its badge, and /watchlist/ with one item of every kind.
// Checks: no sideways scrolling, no page or console errors. Throwaway local database only.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { ACTIONS } from "../src/lib/account.ts";

const [dbUrl, distArg, outArg] = process.argv.slice(2);
if (!dbUrl || !/(127\.0\.0\.1|localhost)/.test(dbUrl) || !distArg || !outArg) { console.error("usage: node web/scripts/accounts-shots.mjs <local-db-url> <dist-dir> <out-dir>"); process.exit(2); }
const webDir = new URL("../", import.meta.url).pathname;
const dist = resolve(distArg), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 8792), BASE = `http://localhost:${PORT}`;
const U = "user_shots_0000000000000001";
const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
let failed = 0, ran = 0;
const ok = (c, label, extra = "") => { ran++; if (!c) { failed++; console.log("  x", label, extra); } else console.log("  ok", label); };

// ── the database as the signed-in user, the way PostgREST would call it ──
async function as(sub, text, params = []) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${sub ? "authenticated" : "anon"}`);
    await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role: "authenticated" } : { role: "anon" })]);
    return tx.unsafe(text, params);
  });
}
const rpc = async (sub, fn, args = {}) => {
  const keys = Object.keys(args);
  return (await as(sub, `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? sql.json(args[k]) : args[k]))))[0].r;
};

// ── fixtures: one item of every kind, all from real records ──
const dashed = (n) => `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 9)}-${n.slice(9)}`;
const nsns = await sql`select n.nsn::text as nsn, n.fsc::text as fsc, n.item_name from pub.nsns n
  where exists (select 1 from pub.solicitations s where s.nsn = n.nsn and s.status = 'open' and (s.return_by is null or s.return_by >= current_date))
    and exists (select 1 from pub.price_points p where p.nsn = n.nsn and p.cage is not null)
    and exists (select 1 from pub.fsc f where f.fsc = n.fsc and f.render_depth = 'deep')
  order by (select count(*) from pub.price_points p where p.nsn = n.nsn) desc limit 3`;
const [N1, N2] = nsns;
const [{ cage: CAGE }] = await sql`select cage::text as cage from pub.price_points where nsn = ${N1.nsn} and cage is not null order by awarded_on desc limit 1`;
await sql`insert into pub.part_numbers (nsn, part_number, cage, source, source_url) select ${N1.nsn}, 'SHOT-PN-1', ${CAGE}, 'test', 'https://x/pn' where not exists (select 1 from pub.part_numbers where cage = ${CAGE})`;
const [{ sol_number: SOL }] = await sql`select sol_number from pub.solicitations where nsn = ${N1.nsn} and status = 'open' order by sol_number limit 1`;
const agency = (await sql`select agency_slug(a.name) as slug from pub.agencies a where exists (select 1 from pub.price_points p where p.agency_id = a.agency_id) order by a.agency_id limit 1`)[0].slug;
// the local data has one award per NSN: add a few so the price sparkline has something to draw
await sql`delete from pub.price_points where award_ref like 'SHOT-AW-%'`;
for (let k = 0; k < 9; k++) {
  await sql`insert into pub.price_points (nsn, awarded_on, unit_price, quantity, total_value, cage, agency_id, sol_number, award_ref, source, source_url, raw)
            values (${N1.nsn}, current_date - (${(9 - k) * 30}::int), ${(12 + Math.sin(k) * 3 + k * 0.4).toFixed(2)}, ${10 + k}, ${(12 + k) * (10 + k)}, ${CAGE}, null, null, ${"SHOT-AW-" + k}, 'dibbs_award', 'https://x/aw', '{}')`;
}
await sql`delete from accounts where id = ${U}`;
await rpc(U, "account_touch", {});
for (const [kind, key, label] of [
  ["nsn", N1.nsn, N1.item_name], ["supplier", CAGE, "Supplier (wins)"], ["manufacturer", CAGE, "Supplier (makes)"], ["fsc", N1.fsc, "Class"],
  ["solicitation", SOL, SOL], ["agency", agency, "Agency"], ["search", `fsc=${N1.fsc};closes=30`, `Open demand: FSC ${N1.fsc}, closing within 30 days`],
]) await rpc(U, "follow", { p_kind: kind, p_key: key, p_label: label, p_on: true, p_list: null });
await sql`update watchlist_items set added_at = '2000-01-01' where list_id in (select id from watchlists where account_id = ${U}) and kind in ('nsn', 'supplier', 'fsc', 'search')`;

// ── wrangler pages dev serves the real pages; only the account API is answered here ──
const devVars = `${webDir}.dev.vars`;
writeFileSync(devVars, `DATABASE_URL="${dbUrl}"\n`);
const wr = spawn("npx", ["--yes", "wrangler@4", "pages", "dev", dist, "--compatibility-flags", "nodejs_compat", "--port", String(PORT), "--ip", "127.0.0.1"],
  { cwd: webDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
let wlog = ""; wr.stdout.on("data", (d) => (wlog += d)); wr.stderr.on("data", (d) => (wlog += d));
const cleanup = async () => { try { process.kill(-wr.pid, "SIGKILL"); } catch { wr.kill("SIGKILL"); } rmSync(devVars, { force: true }); await sql`delete from accounts where id = ${U}`.catch(() => {}); await sql`delete from pub.part_numbers where part_number = 'SHOT-PN-1'`.catch(() => {}); await sql`delete from pub.price_points where award_ref like 'SHOT-AW-%'`.catch(() => {}); await sql.end(); };

let chromium;
try { ({ chromium } = await import("playwright")); } catch { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); }
let browser;
const json = (body, status = 200) => ({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

async function answerAccountApi(context) {
  await context.route(/\/api\/me(\?|$)/, async (route) => {
    const state = await rpc(U, "my_state", {});
    await route.fulfill(json({ signedIn: true, available: true, email: "you@example.test", ...state }));
  });
  await context.route(/\/api\/account\/([a-z-]+)(\?|$)/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").pop();
    const a = ACTIONS[action];
    if (!a) return route.fulfill(json({ error: "Not found." }, 404));
    let args = {};
    if (route.request().method() === "POST") args = a.args(JSON.parse(route.request().postData() || "{}"));
    if (typeof args === "string") return route.fulfill(json({ error: args }, 400));
    try { await route.fulfill(json(await rpc(a.anon ? null : U, a.fn, args))); } catch (e) { await route.fulfill(json({ error: e.message }, 400)); }
  });
}

const VIEWS = [
  { name: "desktop-light", viewport: { width: 1280, height: 900 }, dark: false },
  { name: "phone-dark", viewport: { width: 390, height: 844 }, dark: true, mobile: true },
];
try {
  for (let i = 0, good = 0; i < 150 && good < 3; i++) {
    try { const r = await fetch(`${BASE}/watchlist/`); good = r.status === 200 ? good + 1 : 0; } catch { good = 0; }
    await sleep(1000);
  }
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  for (const v of VIEWS) {
    const context = await browser.newContext({ viewport: v.viewport, isMobile: !!v.mobile, hasTouch: !!v.mobile, deviceScaleFactor: 1 });
    await context.addCookies([{ name: "nsn_signed_in", value: "1", url: BASE }]);
    await context.addInitScript((dark) => { try { localStorage.setItem("theme", dark ? "dark" : "light"); localStorage.setItem("analytics", "denied"); } catch { /* optional */ } }, v.dark);
    await answerAccountApi(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_)/.test(m.text())) errors.push(m.text()); });
    const noOverflow = async (label) => {
      const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      ok(w.doc <= w.win, `${v.name}: no sideways scrolling on ${label}`, `${w.doc} > ${w.win}`);
    };
    const go = async (path, ready) => {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      await page.waitForLoadState("networkidle").catch(() => {});
      if (ready) await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
    };
    const themeOk = async () => ok((await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark")) === v.dark, `${v.name}: theme is ${v.dark ? "dark" : "light"}`);

    // NSN page, not followed (a different NSN than the list holds)
    await go(`/nsn/${dashed(N2.nsn)}/`, "[data-follow]:not([hidden])");
    await themeOk();
    ok(await page.locator("[data-follow][data-kind=nsn]").isVisible() && (await page.locator("[data-follow][data-kind=nsn]").getAttribute("aria-pressed")) === "false", `${v.name}: NSN page shows Follow`);
    await noOverflow("the NSN page");
    await page.screenshot({ path: `${out}/${v.name}-nsn-follow.png` });
    ok(!(await page.locator("#acctBtn .acct-badge").isHidden()), `${v.name}: header badge shows`);
    const badgeText = await page.locator("#acctBtn .acct-badge").innerText();
    ok(Number(badgeText) >= 1, `${v.name}: badge counts changed items`, badgeText);
    await page.screenshot({ path: `${out}/${v.name}-header-badge.png`, clip: { x: 0, y: 0, width: v.viewport.width, height: 72 } });
    // the same NSN page followed
    await go(`/nsn/${dashed(N1.nsn)}/`, "[data-follow][aria-pressed=true]");
    ok((await page.locator("[data-follow][data-kind=nsn]").getAttribute("aria-pressed")) === "true", `${v.name}: a followed NSN reads Following`);
    await page.screenshot({ path: `${out}/${v.name}-nsn-following.png` });

    // supplier page: both toggles
    await go(`/supplier/${CAGE}/`, "[data-follow][data-kind=manufacturer]:not([hidden])");
    ok(await page.locator("[data-follow][data-kind=supplier]").isVisible() && await page.locator("[data-follow][data-kind=manufacturer]").isVisible(), `${v.name}: supplier page shows both toggles`);
    await noOverflow("the supplier page");
    await page.screenshot({ path: `${out}/${v.name}-supplier-toggles.png` });
    // unfollow the manufacturer to show the two states side by side
    await page.locator("[data-follow][data-kind=manufacturer]").click(); await page.waitForTimeout(900);
    ok((await page.locator("[data-follow][data-kind=manufacturer]").getAttribute("aria-pressed")) === "false" && (await page.locator("[data-follow][data-kind=supplier]").getAttribute("aria-pressed")) === "true", `${v.name}: the two toggles work independently`);
    await page.screenshot({ path: `${out}/${v.name}-supplier-toggles-mixed.png` });
    await page.locator("[data-follow][data-kind=manufacturer]").click(); await page.waitForTimeout(900);

    // class open-demand page: Save this search
    await go(`/open/${N1.fsc}/`, "[data-save-search]:not([hidden])");
    ok(await page.locator("[data-save-search]").isVisible(), `${v.name}: Save this search shows on the class page`);
    await noOverflow("the class open-demand page");

    // the watchlist
    await go("/watchlist/", ".wl-list .wl-row");
    ok(await page.locator(".wl-list .wl-row").count() === 7, `${v.name}: /watchlist/ has one row of every kind`, String(await page.locator(".wl-list .wl-row").count()));
    ok(await page.locator(".wl-change").count() >= 3, `${v.name}: /watchlist/ lists what changed`);
    ok(!/No record found/.test(await page.locator("[data-wl-body]").innerText()), `${v.name}: every row has a card`);
    await noOverflow("/watchlist/");
    await page.screenshot({ path: `${out}/${v.name}-watchlist.png`, fullPage: true });
    await page.screenshot({ path: `${out}/${v.name}-watchlist-top.png` });
    await page.locator(".wl-list").first().screenshot({ path: `${out}/${v.name}-watchlist-list.png` });
    ok(errors.length === 0, `${v.name}: no page or console errors`, errors.slice(0, 3).join(" | "));
    await context.close();
  }
} catch (e) {
  failed++; console.log("  x crashed:", e.stack ?? e.message);
  console.log(wlog.slice(-1500));
} finally {
  await browser?.close();
  await cleanup();
}
console.log(`${failed ? "FAIL" : "PASS"} ${ran - failed}/${ran} screenshot checks passed; images in ${out}`);
process.exit(failed ? 1 : 0);
