# NSN Explorer design system

Direction (Peter, 2026-11-24): a quiet reference tool. Cool white, grey hairlines, one federal-navy accent,
self-hosted Inter, light theme by default with a dark option. The compass-nut logo is kept as it is; its
green needle is the only green that is not a value signal.

The CSS lives in `web/src/styles/tokens.css` (variables) and `global.css` / `viz.css` (components). Old
variable names (`--paper`, `--ink`, `--green` ...) are aliases of the new tokens so older component CSS
follows the system without being rewritten line by line.

## Space

A 4 px scale. Use only these steps.

| token | px | typical use |
|---|---|---|
| `--s1` | 4 | icon to label, badge padding |
| `--s2` | 8 | gap inside a control, between chips |
| `--s3` | 12 | table cell side padding, label to value |
| `--s4` | 16 | gutter on phones, gap between related blocks |
| `--s5` | 24 | gutter on desktop, gap between groups |
| `--s6` | 32 | between sections |
| `--s7` | 48 | before a page part (tab group, footer) |
| `--s8` | 64 | page bottom |

Space separates groups before lines do; lines separate rows; boxes are for things you act on (inputs,
buttons, the open-bid panel) and almost nothing else.

## Type

Inter (latin subset, 400 and 600, about 24 KB each, `public/fonts/`), with a metric-matched Arial
fallback so the swap does not move anything. Four sizes, two weights:

| token | size / line | used for |
|---|---|---|
| `--t-small` | 13 / 18 | labels, table headers, captions, meta, badges |
| `--t-body` | 15 / 22 | body text, table cells, controls |
| `--t-head` | 20 / 28 | section headings (h2), key-figure values |
| `--t-title` | 28 / 34 | the page title (h1) |

Weights: 400 for reading, 600 for headings, values and the one thing in a row you came for. h3 uses
`--t-body` at 600. Every number is `font-variant-numeric: tabular-nums` (set on `body`). Codes (NSN, CAGE,
solicitation numbers) are Inter with tabular figures, not monospace.

## Colour

Neutral greys, one accent, value colours only as values. All pairs meet WCAG AA (4.5:1 text, 3:1 graphics).

| token | light | dark | meaning |
|---|---|---|---|
| `--bg` | #FFFFFF | #0F1215 | page |
| `--surface` | #F5F7F9 | #171B20 | quiet panel, header of a table group, hover |
| `--line` | #E2E6EA | #2A3038 | hairline |
| `--line-strong` | #C9CFD6 | #3B434D | heavier rule (table header underline) |
| `--control` | #858D97 | #6E7781 | borders of inputs, chips and secondary buttons (3:1 or more) |
| `--text` | #14171A | #E8EAED | primary text |
| `--text-2` | #4F5761 | #A9B0B8 | secondary text, labels (7.2:1 / 7.9:1) |
| `--text-3` | #636B75 | #8A929B | tertiary, axis text (5.0:1 / 5.5:1 on surface) |
| `--accent` | #1D3F72 | #8EB3EE | links, current tab, selected control, primary chart series |
| `--accent-weak` | #E9EEF6 | #1B2737 | selected background, focus halo |
| `--pos` | #0B7A47 | #3CC37A | a positive change or a price below the usual |
| `--neg` | #B42318 | #F0716A | a negative change, past due, a price above the usual |

Rules: red and green appear only on values that are negative or positive, and never alone; an arrow,
sign or word carries the same meaning. Status that is not good or bad (sole source, set-aside,
"has drawing") is a neutral badge with words. The logo keeps its own green needle.

## Layout

Content width 1200 px, 24 px gutters (16 px under 640 px). Breakpoints used in CSS: 640, 900, 1100.
Every width from 320 to 1440 is checked for sideways scroll by `tools/design-audit/measure.py`.

Page order: title block, key facts, one or two charts, tab bar, groups of sections. Ad positions are
fixed elements in source order (`AdSlot`), reserved but not rendered while ads are off.

## Components

**Title block.** Breadcrumb (13), h1 (28), identity line (codes as plain text with a copy button), one
summary sentence (15, `--text-2`). No eyebrow, no hero art on detail pages.

**Key facts.** `dl.kv` grid: label above value, value at `--t-head` 600, optional sparkline under it and
an optional one-line note. Four across on desktop, two on phones. No boxes; a hairline under the group.

**Label and value list.** `dl.facts`: two columns (label 13 `--text-2`, value 15) on hairline rows, used
for record details and specifications. Long lists open on eight rows with "Show all N".

**Tables.** Hairline rows, no outer box. Header 13 `--text-2`, sticky under the site header. Numbers
right-aligned with tabular figures. Sortable columns have a button in the header (`data-sort`), sort state
in `aria-sort`. Two densities: comfortable (40 px rows) and compact (32 px), chosen per visit with the
density toggle. Long tables open on five rows with "Show all N rows"; the other rows stay in the HTML.
First column sticky when the table scrolls sideways.

**Tabs with an All tab.** When a page has several groups of sections, a tab bar shows one group at a
time; "All" shows every group in order. The choice is remembered for the visit (`sessionStorage`
`nsn.tab.<page type>`). Without JavaScript all groups show. A link to anything inside a hidden group
switches to that group, opens any fold, reveals the row and scrolls to it.

**Folds.** Reference sections start closed (`details.fold`): a 15/600 summary line with a count and a
chevron, hairline below. Open state is not remembered across pages.

**Badges.** 13/600 text on `--surface`, 4 px radius. A badge is a word, never only a colour.

**Buttons.** Primary: `--accent` fill, white text. Secondary: `--control` border, `--text`. 36 px
tall (44 px touch target with padding on phones). 6 px radius.

**Chips.** For filters: 32 px, 1 px `--control` border, selected = `--accent-weak` fill and `--accent`
text plus a check mark.

## Charts

One set of forms, drawn the same way everywhere (server-rendered SVG, `lib/viz.ts`):

- **Sparkline** under a key figure: 96 x 24, 1.5 px `--accent` line, last point dotted, no axes. The
  figure above it carries the number; the sparkline only shows direction.
- **Bars with direct labels**: horizontal bars, label left, value at the bar end, no axis, no legend.
  Used for rankings (who wins, who buys, which classes).
- **Small multiples**: several identical small charts on one shared scale in a grid, titled by the thing
  they show. Used for comparing classes, agencies or years.
- **Time series** (price history, demand): one `--accent` series, a light grey second series only when
  it is the same measure (e.g. this part vs its class), gridlines in `--line`, axis text 11 px `--text-3`,
  dated "as of" note under the chart.

Series colours: `--accent` first, `--text-3` second; `--pos`/`--neg` only for values that are good or bad.
Every chart has a text equivalent (caption plus the table it was drawn from, folded).

## Header

Height 56 px. Logo at 28 px, the U.S. flag beside it at the logo's cap height (`components/Flag.astro`,
a 19:10 SVG with 13 stripes and a 50-star canton drawn as 5-point stars, fixed `width`/`height`
attributes so it reserves its space before paint). Search field always visible on desktop; on phones a
search button. Primary links: Find work, Catalog, Suppliers, Agencies, More.

## Footer

Logo, data-honesty line, navigation in three short columns, the freshness strip, the institutions row
("Public buying data from" + names in text, a 20 px emblem slot per name, empty until a permission
arrives; see `design/emblems.md`), the non-endorsement line, copyright.

## Behaviour stored in the browser

Named on the privacy page before shipping (privacy page, "Stored in your browser"):

- `theme` (localStorage, existing): light or dark.
- `analytics`, `analytics-region` (localStorage, existing).
- `nsn.capabilities` (localStorage, new): the supply classes a visitor picks on the home page.
- `nsn.tab.*`, `nsn.density` (sessionStorage, new): tab and row density chosen during this visit.
