# Government Parts Explorer

What the government actually paid, per part, with the receipts.

Two layers in one monorepo:

- **The Explorer** (`/web`) — a free public tool rendering US government
  purchasing data per NSN: price history, buying agency, competition status
  (AMSC), and a link to every underlying government record. It sells nothing;
  it is the authority and inbound engine.
- **The engine** (`/ingest`, `/scoring`, the `ops` schema) — private rails that
  target DLA solicitations (the Quoter) and sole-source challenge candidates
  (the Challenger). Never rendered publicly.

## Layout

| Path | What it is |
|---|---|
| `/web` | Astro static site (Cloudflare Pages). Reads `pub.*` only, read-only role. |
| `/ingest` | Scheduled fetchers/loaders: USAspending, DIBBS, PUB LOG. |
| `/scoring` | Target-scoring v1 (`scoring-model-v1.md`, private docs repo) → `ops.targets`. |
| `/shared` | DB pool, NSN normalization, CSV parsing. |
| `/db` | Migrations + runner. Two schemas: `pub` (public data) / `ops` (private). |
| `/docs` | Architecture, specs, scoring model, compliance fence, runbook, Phase-1 plan. |
| `.github/workflows` | Deploy on push; daily + monthly ingestion crons. |

## The two rules that don't bend

1. **No price publishes without a link to its underlying government record.**
   Enforced by schema (`NOT NULL source_url`) and again at build time (the build
   fails on any renderable record missing its link).
2. **The compliance fence** (`compliance-fence.md`, private docs repo): this repo and its
   database only ever touch public, uncontrolled data. Export-controlled
   technical data never enters any system reachable from outside the US side.

## Run locally

```bash
npm ci
node db/migrate.mjs                                   # DATABASE_URL (see .env.example) or local default
node ingest/usaspending/load.mjs --file data.jsonl --psc 5331
npm run build --workspace web                         # static site in web/dist
npm test --workspace shared && npm test --workspace ingest
```

## Deploy

The deploy runbook, architecture notes, scoring model and roadmap live in the
private companion repo `pfouge/nsnexplorer-docs` (this repo is public so its
GitHub Actions lanes run on free minutes). `docs/...` references in code
comments point at files in that repo.
