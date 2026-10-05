-- One row per day of headline market counts, so the site can draw trend
-- lines next to its headline numbers. Written once a day by
-- db/freshness.mjs (see recordDailyStats); never back-filled or edited.
BEGIN;
CREATE TABLE IF NOT EXISTS pub.daily_stats (
  day                 date PRIMARY KEY,
  open_solicitations  integer NOT NULL,
  posted              integer NOT NULL,          -- solicitations issued on the newest issue date
  closing_7d          integer NOT NULL,          -- open, return_by within the next 7 days
  award_dollars_7d    numeric NOT NULL,          -- DIBBS award totals dated in the last 7 days
  open_service_notices integer NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
COMMIT;
