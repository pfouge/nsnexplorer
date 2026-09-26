-- Adds pub.fsc.updated_at so the FSC-name backfill (db/backfill-fsc-names.mjs)
-- and the ingest loaders' placeholder->real-name upserts (ingest/dibbs/load.mjs,
-- ingest/sam/load.mjs) can stamp when a row's name was last touched, matching
-- the updated_at convention already used on pub.nsns/pub.solicitations.

ALTER TABLE pub.fsc
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
