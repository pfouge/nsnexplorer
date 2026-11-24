# Home page: two directions, scored (2026-11-24)

Both built from the same components on production data (previews: redesign-qa = A, home-b = B) and
measured in the browser at 390 x 844 and 1280 x 800. Before: 56.2 phone screens, 45.9 desktop screens.

| | A: matcher first | B: market first |
|---|---|---|
| Order | headline, search, key figures, capability matcher, open demand today, browse, about, FAQ | headline and search beside key figures, open demand today, capability matcher, browse, about, FAQ |
| Page height, phone / desktop (screens) | 8.5 / 5.5 | 8.4 / 5.6 |
| Search box, phone / desktop (screens down) | 0.36 / 0.35 | 0.36 / 0.35 |
| Capability matcher, phone / desktop | 0.94 / 0.79 | 1.89 / 1.52 |
| Market charts, phone / desktop | 2.13 / 1.60 | 0.88 / 0.69 |
| Sideways scroll | none | none |

Scored against the discovery tasks, weighted by engaged sessions: task 1 (look up an NSN, part number,
CAGE or solicitation) is equal in both; task 3 ("what is open in the classes I make") is reached a full
screen sooner in A and is the job Peter chose for the home page; the market charts serve "sizing up the
market", which no top query asks for. **A is kept.** B's code was removed after the comparison; it is in
the branch `design/home-b` if wanted again.

Checked in the browser on A: picking a chip stores `nsn.capabilities`, the table switches to "Open for bid in
your classes" with the closing-in-7-days count, the soonest-closing list fills, the class finder suggests
"5330 Packing and Gasket Materials" for "gask", and Clear restores the busiest-classes table.
