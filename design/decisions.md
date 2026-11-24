# Decisions made on Peter's behalf (redesign, from 2026-11-24)

Each entry: the choice, why, how to reverse it. Peter's own answers (2026-11-24): quiet reference tool,
capability matcher on the home page, federal navy accent, self-hosted Inter, keep the logo.

| # | Decision | Why | How to reverse |
|---|---|---|---|
| D-1 | Old colour variables (`--paper`, `--ink`, `--green` ...) became aliases of the new tokens in `tokens.css` | Every older stylesheet and inline style follows the new system at once; nothing is left in the old palette | Delete the alias block at the end of `tokens.css` and restore the old `:root` values from git |
| D-2 | Body text 15 px (was 16) | Four sizes only (13, 15, 20, 28); 15 keeps tables and prose on one size, as dense reference tools do | Change `--t-body` in `tokens.css` |
| D-3 | Amber is gone; "sole source" and other non-good/bad states are neutral badges with words | One accent; red and green only for negative and positive | Restore `--amber` in `tokens.css` and `.badge.amber` in `global.css` |
| D-4 | Logo drawn at 31 px tall (was 28) and the flag at 16 px | The flag must sit at the logo's cap height and stay legible at 16 px; the logo's cap height is 0.52 of its height, so 31 px gives a 16 px cap | `Logo height` and `Flag height` in `BaseLayout.astro` |
| D-5 | The animated globe behind the home headline was removed (`heroDeploy.ts`, `landDots.ts`) | Decoration with no information; it moved on every visit | `git revert` the commit that removed them |
| D-6 | Boxed sections (`section.card`) render as plain sections; the open-bid panel is the one box on a part page | Space separates groups; boxes are for things you act on | `section.card` rule in `global.css` |
| D-7 | Part pages: Bid, Specs, Prices, Demand tabs plus All; Bid opens by default; Catalog record, Related items, Earlier stock numbers and About this data start folded | A supplier's first question is whether there is something to bid on; reference material is still one click away and stays in the HTML | `GroupTabs` and `details.fold` in `nsn/[nsn].astro` |
| D-8 | Ad positions are `AdSlot` markers in source order (top, mid, multiplex); they render nothing while `AD_UNITS_ON` is false | Lesson 5: fixed slots, no CSS moves, Auto ads in-page off. The held go-live PR #53 must be rebased onto these slots, and its step "auto ads with in-page banner ads only" should become "auto ads off" | Remove the `AdSlot` lines |
| D-9 | Footer names the institutions in text with an empty 20 px emblem slot each; no emblem is drawn or shipped | Every service requires prior written permission and forbids use implying endorsement; see `design/emblems.md` | Add artwork and approval to `lib/institutions.ts` when permission arrives |
| D-10 | Footer line reads "Proudly helping American suppliers serve the people who serve." followed by "Public buying data from:" | The site serves suppliers, not the services; the line is true and keeps marks away from any endorsement reading | Edit `BaseLayout.astro` |
| D-11 | Em-dashes inside two locked headings on part pages ("What it is — can you make it?", "What it pays — so you can quote") were left as they are | Heading text may not change without Peter's agreement; proposed replacements are in the final report | Change the two `h2` lines in `nsn/[nsn].astro` once agreed |
| D-12 | Null values in tables stay "—" | It is the site's established "no value" mark in data cells, not prose | Search and replace in templates |
| D-13 | Tab and density choices last for the visit (sessionStorage); capability picks persist (localStorage) | The brief asks for choices remembered for the visit; a supplier's capability list is only useful if it survives a return visit. All keys are named on the privacy page | `scripts/disclosure.ts`, `scripts/matcher.ts` |
