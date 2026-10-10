# Locked copy for nsnexplorer.com top-level pages

Placeholders in braces are live counts formatted with `toLocaleString('en-US')`. Every page defines a boolean like `hasCount = N > 0`; when the count is 0 the fallback string is used instead. Never render "0", "undefined" or "NaN" in a title, H1 or description.

Count sources (all from `loadSiteData()`; no new queries):

- `{N}` home parts indexed = `data.openNsnByNsn.size`
- `{S}` open solicitations = `data.stats.openSolicitationsCount`
- `{C}` categories with open demand = `data.openByFsc.size`
- `{T}` all-time solicitations = `data.stats.totalSolicitations`
- `{F}` catalog FSC count = `totalFscs` (already computed in catalog.astro)
- `{G}` catalog FSG count = `departments.length`
- `{K}` catalog NSN count = `totalNsns` (already computed)
- `{D}` deep FSC count = `data.deepFscs.length` (browse: `rows.length`)
- `{M}` deep NSN count = browse: `rows.reduce((s, r) => s + r.count, 0)`
- `{A}` agencies count = agencies: `rows.length`
- `{P}` agency purchases = agencies: `rows.reduce((s, r) => s + r.count, 0)`

---

## / (index.astro)

Title: `NSN Lookup: {N} National Stock Numbers, Free`
Title fallback (N = 0): `NSN Lookup: National Stock Number Search, Free`

Description: `Free NSN lookup across {N} national stock numbers: open DLA solicitations, price history and source links, built from DIBBS, SAM.gov and USAspending.`
Description fallback: `Free NSN lookup and national stock number search: open DLA solicitations, price history and source links, built from DIBBS, SAM.gov and USAspending records.`

H1: `NSN lookup: search {N} national stock numbers, free`
H1 fallback: `NSN lookup: national stock number search, free`
Kicker (visible line directly under the H1, class `lede`, replaces nothing else): `Find the federal parts demand you can fill.`

The existing `<p class="lede">` paragraph in the hero stays as is, below the kicker. The existing eyebrow stays.

Intro (new `<section class="intro">` directly under the hero `</section>`, before the open-callout, no `<hr>`; contains an H2 with class `section-title` reading `A free national stock number search built from official records`, then one `<p class="gloss">`):

`NSN Explorer is a free NSN lookup for suppliers, buyers and researchers. Type any national stock number to see its open DLA solicitations, past purchase prices and the agencies that buy it. Every record comes from a public U.S. government source: DIBBS for solicitations and awards, SAM.gov for contract notices and USAspending for contract actions. The index is rebuilt every day and every figure links back to the official record. No account is needed.` (79 words)

FAQ (new `<section class="faq">` at the end of the page, after the card-grid signup forms and before `</BaseLayout>`; H2 class `section-title` text `NSN lookup questions`; each question an `<h3>`, each answer a `<p class="gloss">`):

1. Q: `What is a national stock number?`
   A: `A national stock number, or NSN, is the 13-digit code the U.S. federal supply system assigns to one specific item. The first four digits are its federal supply class and the rest identify the exact part.`
2. Q: `Is this NSN lookup free?`
   A: `Yes. Every search, solicitation, price and source link on NSN Explorer is free and needs no account. The site sells nothing and does not broker parts.`
3. Q: `Where does the data come from?`
   A: `Solicitations and awards come from DLA's DIBBS bid board, contract notices from SAM.gov and contract actions from USAspending. Each figure on the site links to the government record it was taken from.`
4. Q: `How current is the index?`
   A: `The site is rebuilt from the source systems every day, and open solicitations are refreshed more often than that. A solicitation's closing date is always shown next to it.`

Schema: `breadcrumbs=[{name:'Home', url:'/'}]`; `itemList` = the deep FSCs (name `${f.fsc} ${f.name}`, url `/fsc/${f.fsc}/`), list name `Federal supply classes with full price history`; `faq` = the four pairs above. `pageType` stays `WebPage`.

---

## /open/ (open.astro)

Title: `{S} Open DLA RFQs and Government Solicitations` (changed 2026-10-10: the old title passed 70 characters once the count reached five digits)
Title fallback: `Open DLA RFQs and Government Solicitations`

Description: `{S} open government solicitations from DLA DIBBS, updated daily and linked to the official RFQ. Browse by federal supply class. Free, no account needed.`
Description fallback: `Open government solicitations from DLA DIBBS, updated daily and linked to the official RFQ. Browse open demand by federal supply class. Free, no account needed.`

H1: `{S} open government solicitations, DLA RFQs open for bid`
H1 fallback: `Open government solicitations: DLA RFQs open for bid`
Kicker under H1 (class `lede`): `What the government is buying right now`
The existing long lede paragraph stays below the kicker.

Intro (new section directly under the hero `</header>`, before the first stat-strip, no hairline; H2 `section-title` text `Every DLA solicitation open for bid, in one free list`; one `<p class="gloss">`):

`This page lists every open government solicitation NSN Explorer has indexed from DLA's DIBBS bid board, grouped by federal supply class so a supplier can find the RFQs it can fill. The list is rebuilt every day and open items are refreshed through the day, so the counts below reflect the latest crawl. Each row links to the official DIBBS record where quotes are submitted. Nothing here is a marketplace; it is a free index of public buying activity.` (78 words)

Freshness line: directly below the second stat-strip add `<p class="updated">Updated {buildDate} from DLA DIBBS. Closed solicitations stay on record.</p>` where `buildDate` is `now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })` using the existing `now` constant.

FAQ (end of page, before `</BaseLayout>`; H2 `Open solicitation questions`):

1. Q: `What is a DLA solicitation?`
   A: `A solicitation is the Defense Logistics Agency's public request for quotes on a set quantity of a part, identified by NSN, with a closing date. Suppliers respond with a price and delivery quote through DIBBS.`
2. Q: `How do I bid on one of these RFQs?`
   A: `Click through to the DIBBS record and submit your quote there before the closing date. You need an active SAM.gov registration and a CAGE code; the For Suppliers guide walks through both.`
3. Q: `How often is this list updated?`
   A: `The whole site is rebuilt from DIBBS every day and open solicitations are re-crawled more often than that. The date at the top of the stats shows the last build.`
4. Q: `Does it cost anything to use?`
   A: `No. Browsing, searching and clicking through to the official record are free and require no account. NSN Explorer does not submit bids or broker parts.`

Schema: `breadcrumbs` Home > Open demand (replace the hand-built breadcrumbSchema with the prop); `itemList` = every FSC in `departments[].fscs` (name `FSC ${fsc.fsc} ${fsc.name}`, url `/open/${fsc.fsc}/`), list name `Federal supply classes with open solicitations`; `faq` as above. `pageType` stays `CollectionPage`.

---

## /catalog/ (catalog.astro)

Title: `Federal Supply Class List: {F} FSC Codes`
Title fallback: `Federal Supply Class List: FSC Codes by Group`

Description: `Federal supply class list: {F} FSC codes in {G} federal supply groups, each with NSN counts and price history from DIBBS and USAspending records. Free.`
Description fallback: `Federal supply class list: FSC codes grouped by federal supply group, each with NSN counts and price history from DIBBS and USAspending records. Free to browse.`

H1: `Federal supply class list: {F} FSC codes in {G} groups`
H1 fallback: `Federal supply class list by federal supply group`
Kicker (class `lede`): `Browse the catalog`
Existing lede paragraph stays below the kicker.

Intro (directly under the hero `</header>`, before the stat-strip; H2 `section-title` text `How the federal supply class list is organized`; one `<p class="gloss">`):

`This federal supply class list covers every FSC code NSN Explorer has indexed, grouped under its federal supply group. Pick a group to see its classes, then a class to see the NSNs inside it with their purchase prices and open solicitations. The catalog is built from DLA DIBBS awards and USAspending contract actions, rebuilt every day, and every price links to the government record behind it. It is free to browse and needs no account.` (77 words)

FAQ (end of page; H2 `Federal supply class questions`):

1. Q: `What is a federal supply class?`
   A: `A federal supply class, or FSC, is the four-digit code that groups similar items across the federal supply system, such as 5331 for o-rings. It is the first four digits of every NSN.`
2. Q: `What is the difference between an FSG and an FSC?`
   A: `A federal supply group is the two-digit family a class belongs to, and each group holds several classes. Here groups are shown as departments and classes as categories.`
3. Q: `Why do some classes show more NSNs than others?`
   A: `The count reflects how many NSNs in that class have an indexed government purchase or solicitation. Classes marked as fully indexed have every priced purchase we could find.`

Schema: `breadcrumbs` Home > Catalog (replace hand-built); `itemList` = departments (name `FSG ${d.fsg} ${d.name}`, url `/group/${d.fsg}/`), list name `Federal supply groups`; `faq` as above.

---

## /suppliers/ (suppliers.astro)

Title: `How to Sell Parts to the Government (DIBBS Guide)`
Description: `How to sell parts to the government: SAM.gov registration, your CAGE code, how to bid on DIBBS, and where to find open DLA solicitations. A free plain guide.`

H1: `How to sell parts to the government`
Kicker (class `lede`): `How to win federal parts work`

Replace the existing lede paragraph (the one starting "The U.S. government buys millions of parts") with this intro, still `<p class="lede">`, directly under the kicker:

`This guide explains how to sell parts to the government as a manufacturer or distributor: what a national stock number is, what SAM.gov registration and a CAGE code get you, and how to bid on DIBBS, the DLA board where most parts solicitations are posted. It is free, it is not legal advice, and it links to the official systems at every step. Open solicitations on NSN Explorer come from DIBBS and are refreshed every day.` (76 words)

Add one FAQ section before the closing `.note` block (after the "How to use NSN Explorer" section and its `<hr class="rule" />`); H2 `Common questions about selling to the government`:

1. Q: `How do I bid on DIBBS?`
   A: `Register in SAM.gov, get your CAGE code, then create a DIBBS account at dibbs.bsm.dla.mil. Open an RFQ, read its requirements and submit your quote through DIBBS before the return-by date.`
2. Q: `Do I need a CAGE code to sell parts to the government?`
   A: `Yes for federal work. The CAGE code is issued during SAM.gov registration, which is free, and it identifies your company on every solicitation and award.`
3. Q: `How do I become a DLA supplier?`
   A: `There is no separate approval to become a DLA supplier for competitive parts. Once you are registered in SAM.gov you can quote any open solicitation whose specification you can meet.`
4. Q: `Where do I find open DLA solicitations?`
   A: `DIBBS lists them, and NSN Explorer indexes them by federal supply class with price history, then links back to DIBBS to bid. Both are free.`

Schema: `breadcrumbs` Home > For Suppliers (replace hand-built); `faq` as above. Keep `ogType="article"`. No itemList.

---

## /browse/ (browse.astro)

Title: `NSN Price History: {D} Federal Supply Classes, Free`
Title fallback: `NSN Price History by Federal Supply Class, Free`

Description: `NSN price history for {D} federal supply classes and {M} NSNs, every government purchase price linked to its DIBBS or USAspending record. Free to use.`
Description fallback: `NSN price history by federal supply class, every government purchase price linked to its DIBBS or USAspending source record. Free to use, no account needed.`

H1: `NSN price history: {D} federal supply classes, {M} NSNs`
H1 fallback: `NSN price history by federal supply class`
Kicker (class `lede`): `Browse deep categories`
Existing lede paragraph and button stay below the kicker.

Intro (directly under the buttons, before the list; H2 `section-title` text `Free NSN price history from official award records`; one `<p class="gloss">`):

`Each class below has full NSN price history: every priced government purchase NSN Explorer could find for every NSN in the class, drawn from DLA DIBBS award records and USAspending contract actions. Prices are shown per unit with the date, quantity and buying agency, and each one links to its source record. The index is rebuilt every day. It is free and needs no account, and it exists so suppliers can quote against what the government has actually paid.` (78 words)

FAQ (end of page; H2 `NSN price history questions`):

1. Q: `Where do the prices come from?`
   A: `Unit prices come from DIBBS award records and USAspending contract actions. NSN Explorer will not publish a price that lacks a link to its government source.`
2. Q: `Why are only some federal supply classes listed here?`
   A: `These are the classes where every priced purchase has been indexed. Other classes appear in the catalog with partial history and open solicitations.`
3. Q: `Can I use this to price a quote?`
   A: `Yes, that is what it is for. Look at the recent unit prices and quantities for an NSN, then check the linked records before you bid.`

Schema: `breadcrumbs` Home > Price history (url `/browse/`); `itemList` = rows (name `FSC ${r.fsc.fsc} ${r.fsc.name}`, url `/fsc/${r.fsc.fsc}/`), list name `Federal supply classes with full price history`; `faq`. Add `canonicalUrl` `${SITE_URL}/browse/`. Add a visible breadcrumb nav like the other pages: Home › Price history.

---

## /agencies/ (agencies.astro)

Title: `Federal Parts Spending by Agency: {A} Agencies`
Title fallback: `Federal Parts Spending by Agency`

Description: `Federal parts spending by agency: {A} government agencies ranked by indexed parts purchases, from USAspending and DIBBS records. Free, updated daily.`
Description fallback: `Federal parts spending by agency: which government agencies buy parts, ranked by indexed purchases from USAspending and DIBBS records. Free, updated daily.`

H1: `Federal parts spending by agency: {A} agencies, {P} purchases`
H1 fallback: `Federal parts spending by agency`
Kicker (class `lede`): `Agencies`
Existing one-sentence lede stays below the kicker.

Intro (directly under the lede, before the table; H2 `section-title` text `Which government agencies buy parts`; one `<p class="gloss">`):

`This page shows federal parts spending by agency: every government agency that appears as the buyer on an indexed purchase, ranked by how many purchases NSN Explorer has on record for it. Open an agency to see the NSNs it buys, the prices it has paid and the source record for each. Purchases come from USAspending contract actions and DLA DIBBS awards, the index is rebuilt every day, and it is free to use.` (74 words)

FAQ (end of page; H2 `Agency spending questions`):

1. Q: `Which government agencies buy the most parts?`
   A: `In these records the Defense Logistics Agency and the military services account for most parts purchases. The table ranks every indexed agency by purchase count.`
2. Q: `Why is an agency missing?`
   A: `Only agencies named as the buyer on an indexed price point appear. As more federal supply classes are fully indexed, more agencies will show up.`
3. Q: `Is this total federal spending?`
   A: `No. It covers indexed parts purchases with a unit price, not an agency's whole budget. Contract action totals are shown separately on NSN pages.`

Schema: `breadcrumbs` Home > Agencies; `itemList` = rows (name `r.agency.name`, url `/agency/${r.agency.slug}/`), list name `Government agencies with indexed parts purchases`; `faq`. Add `canonicalUrl` and a visible breadcrumb nav.

---

## /methodology/ (methodology.astro)

Title: `Methodology: DIBBS, SAM.gov and USAspending Data`
Description: `How NSN Explorer builds parts prices and open solicitations from DIBBS, SAM.gov and USAspending records, what each figure means, and how to check any of them.`

H1: `Government procurement data sources and methodology`
Kicker (class `lede`): `Methodology`

Replace the existing lede paragraph with this one (`<p class="lede">`, directly under the kicker):

`This page lists the government procurement data sources behind every figure on NSN Explorer and explains how each one is used. Prices, solicitations and contract totals come from three public systems: DLA's DIBBS bid board, SAM.gov contract notices and USAspending contract actions. The index is rebuilt every day, nothing is estimated or modeled, and every number links to the record it came from so a supplier, buyer or reporter can check it. The site is free.` (78 words)

Add a new section after the AMSC/AMC section and before "Price spikes" (with the usual `<hr class="rule" />` between, matching the page's existing pattern): H2 `DIBBS data explained`, `<p class="gloss">`:

`DIBBS is the DLA Internet Bid Board System, where the Defense Logistics Agency posts requests for quote and records awards. NSN Explorer reads each open solicitation's NSN, item name, quantity, return-by date and set-aside or competition code, and each award's unit price, quantity and winning supplier. Solicitations are kept after they close so the demand record grows over time. Every DIBBS row on the site links to its record at dibbs.bsm.dla.mil.`

FAQ (before the SignupForm at the end; H2 `Methodology questions`):

1. Q: `What government procurement data sources does NSN Explorer use?`
   A: `Three: DLA DIBBS for solicitations and awards, SAM.gov for contract notices and USAspending for contract actions. All three are public and free.`
2. Q: `Is any figure estimated?`
   A: `No. Every price, quantity and total is copied from a government record and links to it. The site build rejects any price point without a source URL.`
3. Q: `How often is the data refreshed?`
   A: `The site is rebuilt every day from the source systems, and open solicitations are re-crawled more often. Records may still lag the underlying events.`
4. Q: `What does a price spike mean?`
   A: `A purchase is flagged when its unit price is at least three times the NSN's trailing median. It is a mechanical threshold to prompt a closer look, not a finding.`

Schema: `breadcrumbs` Home > Methodology; `faq`. Add `canonicalUrl`.

---

## /about/ (about.astro)

Title: `About NSN Explorer: Free Government Parts Data` (contains the site name, so the component will not add the suffix)
Description: `NSN Explorer is a free, independent index of U.S. government parts solicitations and prices built from public DIBBS, SAM.gov and USAspending records.`
H1 unchanged. Schema: `breadcrumbs` Home > About. Nothing else changes.
