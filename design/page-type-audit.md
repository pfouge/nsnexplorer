# Page-type audit (Phase 0), 2026-11-24

## How this was measured

`tools/design-audit/` builds the site from a frozen copy of the production database (all 193,302 parts,
184,359 solicitations, 2.8 million contract actions) in GitHub Actions and measures every page type with
Playwright at 390 x 844, 768 x 1024 and 1280 x 800, then sweeps every width from 320 to 1440 px in 10 px
steps for sideways scroll. `compare.py` checks two builds page by page (status, title, meta, canonical,
headings, JSON-LD, table rows, ids, numbers, internal links). Baseline: run 45434793672 (main at 52eb359);
screenshots at all three widths are in that run's `design-audit` artifact. The noise floor (main against
itself) was 0 differences on every route.

## Who comes and what they do

Real visitors are a small U.S. audience: 2,131 U.S. sessions in 90 days (332 engaged) against 302,560 bot
sessions from Singapore and 3,758 from China, which a Cloudflare challenge has stopped since 2026-11-15.
U.S. sessions are 94% desktop. Search arrives mostly from Bing (206 sessions, 126 engaged) and ChatGPT
(70 sessions, 43 engaged); Google sent 32. Search Console is not connected to the reporting account for
this property, so Bing queries and GA4 site search stand in.

Engaged U.S. sessions by page type (90 days): part pages 406, home 167, open-demand class pages 143, class
pages 102, open-demand hub 68, solicitation pages 63 (1,118 views, mostly one-page visits from search),
group pages 58, catalog 35, supplier pages 28, about 25, browse 23. That is the rollout order.

The five most common tasks, in visitors' words (Bing queries, site search terms, landing pages):

1. "I have an NSN and need what it is, what it sold for and whether it is open for bid" (`nsn lookup`,
   `9140013132192 nsn prices`, `nsn lookup with cost`, `nsn price history`, bare NSNs).
2. "I have a solicitation number and want the part, quantity, deadline and drawings" (`spe4a6-27-t-0414`,
   `spe1c1-27-t-0127 bid`, `w911s227u0174`, SAM notice ids).
3. "Show me what is open in the classes I can make, closing soon" (open-demand class pages, `fsc 1080`,
   `federal supply fsc 5961`, site search `lock washer`, `grip washer`).
4. "Who makes this, or who is this CAGE" (`marotta controls inc company number`, `6r888`,
   `avair, llc cage code`, part-number searches such as `81000-65401`).
5. "What is an NSN, an FSC or a CAGE code" (`what is a cage code`, `list of fsc codes`,
   `is a nsn 13 digits`).

## Page types

| Page type | Example | Pages | Phone screens (390) | Desktop screens (1280) | First answer at (screens, 390) | Longest table | CLS | Sideways scroll widths |
|---|---|---|---|---|---|---|---|---|
| Part (NSN) | /nsn/5970-01-012-4280/ (heaviest) | 193,302 on demand | 26.8 | 23.6 | 0.56 | 75 | 0.048 | 6 |
| Part, typical | /nsn/5330-01-651-7290/ | | 16.2 | 13.4 | 0.52 | 20 | 0.051 | 6 |
| Part, sparse | /nsn/0001-01-628-2149/ | | 9.0 | 6.8 | 1.10 | 3 | 0.042 | 6 |
| Home | / | 1 | 56.2 | 45.9 | 1.39 | 0 | 0.075 | 6 |
| Open-demand class | /open/5340/ | 694 incl. pages | 13.9 | 7.5 | 0.54 | 0 | 0.070 | 6 |
| Open-demand class, sparse | /open/9999/ | | 2.7 | 2.2 | 0.54 | 0 | 0.364 | 6 |
| Class | /fsc/5330/ | 848 incl. pages | 12.1 | 8.8 | 0.48 | 25 | 0.037 | 6 |
| Class, sparse | /fsc/0099/ | | 2.7 | 2.1 | 0.48 | 0 | 0.053 | 6 |
| Open-demand hub | /open/ | 1 | 49.6 | 31.1 | 1.08 | 20 | 0.098 | 6 |
| Solicitation | /solicitation/0000963801/ | 184,359 on demand | 4.7 | 3.7 | 0.31 | 0 | 0.042 | 6 |
| Group | /group/53/ | 79 | 6.0 | 3.8 | 0.37 | 1 | 0.042 | 6 |
| Catalog | /catalog/ | 1 | 10.0 | 5.4 | 0.76 | 0 | 0.056 | 6 |
| Supplier | /supplier/0ZBE8/ | 32,782 on demand | 33.3 | 31.6 | 2.36 | 200 | 0.015 | 6 |
| Supplier, sparse | /supplier/00060/ | | 11.0 | 8.4 | 1.90 | 25 | 0.040 | 6 |
| Supplier leaderboard | /supplier/ | 1 | 49.0 | 29.0 | 0.44 | 100 | 0.035 | 6 |
| Price history (browse) | /browse/ | 1 | 52.8 | 42.9 | none | 0 | 0.069 | 6 |
| Agencies | /agencies/ | 1 | 8.6 | 8.4 | 0.83 | 105 | 0.026 | 6 |
| Agency | /agency/defense-logistics-agency/ | 105 | 8.2 | 7.1 | 0.37 | 25 | 0.036 | 6 |
| Services hub | /services/ | 1 | 8.6 | 6.3 | 0.41 | 20 | 0.039 | 6 |
| Services category | /services/j/ | 30 | 16.7 | 13.6 | 0.42 | 0 | 0.001 | 6 |
| Guides | /guides/amc-amsc-codes/ | 9 | 11.4 | 8.1 | 1.28 | 26 | 0.001 | 6 |
| Search | /search/?q=5310-00-015-3857 | on demand | 10.7 | 8.2 | 1.05 | 18 | 0.046 | 6 |
| Methodology | /methodology/ | 1 | 8.1 | 5.7 | none | 0 | 0.227 | 6 |
| Watchlist | /watchlist/ | 1 | 1.7 | 1.3 | none | 0 | 0.266 | 6 |
| About, contact, privacy, terms, lookup, compare, 404 | | 7 | 1.6 to 11.8 | | | | up to 0.062 | 6 |
| Embeds | /embed/fsc/5330/demand/ | 2 types | 1.0 | 1.0 | | | 0 | 0 |

Every non-embed page had a few pixels of sideways scroll at six widths in the sweep (the same header and
footer on every page). First answer: how far down the first table row, key figure or chart sits.

## What is wrong for the visitor, worst first

**Part page.** (1) The answer to "is it open, what did it sell for" is split: a price strip at the top, the
open-bid table below, prices again further down, and the competition read in between; a sparse part opens
on a lede and empty strips. (2) Up to 27 phone screens, with reference tables (catalog record, related
items, earlier stock numbers, management records) at full length in the middle. (3) Long purchase and
demand tables at full length. (4) Seven in-page anchors that only scroll, so nothing is ever out of the way.

**Home.** (1) 56 phone screens, almost all of it a flat list of 557 priced classes. (2) The supplier's real
question, "what can I bid on", needs four clicks. (3) A moving globe and a moving tape take the first screen.

**Open-demand class.** (1) 60 result rows before "Show all" on phones. (2) The sparse page shifts (CLS 0.36).

**Class.** (1) Five charts before the product list a visitor came for. (2) 60 rows before "Show all".

**Open-demand hub.** (1) 50 phone screens of category cards, one card per class. (2) A twenty-row closing
table ahead of the categories.

**Solicitation.** Short already; the fixes are shared ones (type, tables, folds for history).

**Supplier.** (1) 33 phone screens; a 200-row award table at full length. (2) Company details ahead of
performance, which is what a competitor or buyer looks at first.

**Leaderboard, browse.** 49 and 53 phone screens of rows.

**Everywhere.** (1) Two bold weights and about 15 font sizes. (2) Boxes around most sections. (3) Green used
for links, accents and money alike, so it no longer means "good". (4) Sideways scroll at six widths.

## How comparable tools present the same data

Read directly: McMaster-Carr, LogiQuest Lite, ISO Group, HigherGov (opportunity page), FRED, SAM.gov
search (in Chrome). Read through documentation only: GovTribe, WBParts, NSN Center, AeroBase, DIBBS Navigator,
USAspending, Octopart. Not reachable: Digi-Key, Our World in Data, Wikipedia (fetch not permitted), DIBBS.

What each does well, by task: McMaster puts a label/value spec table beside the drawing and a download, so a
maker checks fit in one look (task 1, 4). LogiQuest opens on an identity strip with an active/historical
flag (task 1). HigherGov's opportunity page opens on quantity, approved sources, tech-data availability and
pricing context, and shows counts on its tabs (task 2). DIBBS Navigator flags tech data, set-aside, QPL and
fast award on every row and lets a supplier save classes (task 3). AeroBase lists CAGE by class with counts
(task 4). FRED dates every series ("updated", "next release"). Octopart's price-by-quantity table is the
clearest price history for a buyer (task 1). Nobody handles empty states well: blank panels with no reason.

## Best display for each kind of data, for a supplier deciding what to make or source

| Data | Display | Why it serves the supplier |
|---|---|---|
| Part identity | Title block: item name, NSN with copy, NIIN, class link, one summary sentence | Confirms in a second that this is the part; the NSN is what goes on the quote |
| Is it open now | First key figure, linked to the open-bid panel; next close date under it; the panel is the one boxed element on the page | The decision to bid starts here |
| What it sells for | Key figure with a 24-point sparkline, award date under it; full purchase table sortable by date, quantity and price, five rows first | A quote is a price against the last awards; the sparkline shows direction without a chart |
| Can I win it | Plain label (competitive, restricted, sole source) plus the inputs: codes, listed sources, distinct winners, streak | A supplier needs the reasons, not a score |
| Can I make it | Drawing first (generated or standard document), then a label/value spec table, then approved part numbers with CAGE | Mirrors how a maker checks fit: shape, then numbers, then who already qualifies |
| Who buys, how often | Demand rhythm chart and the solicitation history table, five rows first | Repeat demand is the case for tooling up |
| Who wins | Bars with direct labels (winner, count, share) | A ranking reads fastest as bars with the number at the end |
| Class overview | Key figures (open bids, 90-day awards, active suppliers), then the parts list with filters; charts one tab away | The list is what the visitor came for |
| Open demand across classes | One closed fold per supply group with its open count; closing-soon table, eight rows first | Scannable directory instead of 700 cards |
| My classes | Capability matcher on the home page: pick classes, see open bids in them soonest first; kept in this browser | Task 3 in one step, and again on every return visit |
| Supplier profile | Performance first (awards, dollars, classes, top parts, agencies), then parts and open bids, then awards, then company details | Competitor and partner research starts with what they win |
| Agency | Key figures, fiscal-year bars, top classes and recipients as tables, five rows first | Who buys what, and from whom |
| Reference text (methodology, catalog codes, about this data) | Closed folds | Always one click away, never in the way |

## How the seven principles were applied, by page type

Recorded as each page type ships; see the table in `design/rollout.md`.
