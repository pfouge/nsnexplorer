#!/usr/bin/env bash
# Freezes a read-only copy of the production data into a local Postgres so both builds (and the
# request-time pages) render identical data.
# usage: snapshot-db.sh <repo_checkout> ; env SOURCE_DB_URL (secret), TARGET_DB_URL (local, empty database)
# The source is only ever read: one pg_dump connection with default_transaction_read_only on. The schema
# comes from the repository's own migrations, applied to the LOCAL database only.
set -euo pipefail
REPO="$1"
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -q -f "$REPO/web/scripts/supabase-stubs.sql" > /dev/null
(cd "$REPO" && node db/migrate.mjs --database-url="$TARGET_DB_URL") > /tmp/snapshot-migrate.log 2>&1 || { tail -20 /tmp/snapshot-migrate.log; exit 1; }
tail -2 /tmp/snapshot-migrate.log
# node-postgres URL options that libpq rejects are dropped (the URL itself is never printed)
SRC_URL="$(printf %s "$SOURCE_DB_URL" | sed -E 's/([?&])uselibpqcompat=[^&]*&?/\1/; s/[?&]$//')"
PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE="${PGSSLMODE:-require}" pg_dump "$SRC_URL" --data-only --schema=pub --no-owner --no-privileges --format=custom --file=/tmp/pub.dump
ls -l /tmp/pub.dump | awk '{print "dump bytes:", $5}'
pg_restore --dbname="$TARGET_DB_URL" --data-only --disable-triggers --no-owner --exit-on-error /tmp/pub.dump
psql "$TARGET_DB_URL" -At -c "select 'pub.nsns', count(*) from pub.nsns union all select 'pub.price_points', count(*) from pub.price_points union all select 'pub.solicitations', count(*) from pub.solicitations union all select 'pub.contract_actions', count(*) from pub.contract_actions union all select 'pub.suppliers', count(*) from pub.suppliers"
