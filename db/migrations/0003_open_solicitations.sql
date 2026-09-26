-- Open-demand phase: make pub.solicitations the live spine of currently-open
-- government demand, across the ENTIRE catalog (all FSCs), from multiple
-- sources (DIBBS RFQs now, SAM.gov opportunities next).
--
-- The table already models an open solicitation (sol_number, nsn, quantity,
-- issued_on, return_by, status, source_url, raw). This migration adds what a
-- multi-source, all-FSC, self-reconciling open board needs:
--
--   source        -- which system the solicitation came from
--   nomenclature  -- item name as stated on the solicitation (self-describing;
--                    open NSNs may sit in FSCs we have no catalog name for yet)
--   fsc           -- denormalized category, so /open/[fsc]/ queries need no join
--   last_seen_at  -- last crawl that observed this solicitation present/open;
--                    reconciliation flips rows not seen (or DIBBS-"Removed") to
--                    cancelled, and rows past return_by to expired.
--
-- No FK is relaxed. The RFQ loader grows pub.fsc + pub.nsns for any unseen
-- open NSN (placeholder FSC name until FLIS enriches it), so referential
-- integrity holds and every open NSN gets a catalog page. Open-demand
-- rendering reads pub.solicitations directly and is NOT gated by
-- pub.fsc.render_depth — the deep-FSC gate governs only the historic catalog.

ALTER TABLE pub.solicitations
  ADD COLUMN IF NOT EXISTS source       text NOT NULL DEFAULT 'dibbs_rfq'
    CHECK (source IN ('dibbs_rfq', 'sam_gov')),
  ADD COLUMN IF NOT EXISTS nomenclature text,
  ADD COLUMN IF NOT EXISTS fsc          char(4),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- Category browse: open solicitations in one FSC, closing soonest first.
CREATE INDEX IF NOT EXISTS solicitations_fsc_status_idx
  ON pub.solicitations (fsc, status);

-- "Closing soon" board: only open rows, ordered by close date.
CREATE INDEX IF NOT EXISTS solicitations_open_return_by_idx
  ON pub.solicitations (return_by)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS solicitations_source_idx
  ON pub.solicitations (source);
