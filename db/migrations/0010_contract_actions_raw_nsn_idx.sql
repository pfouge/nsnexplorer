-- 0010 — index for the NSN page's contract-action lookup (2026-10-11).
-- loadNsnPage matches contract actions on (raw ->> 'nsn'); without an index that is a
-- sequential scan of pub.contract_actions on every NSN page view that misses the edge cache.
create index if not exists contract_actions_raw_nsn_idx on pub.contract_actions ((raw ->> 'nsn'));
