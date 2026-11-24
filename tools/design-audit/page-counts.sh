#!/usr/bin/env bash
# Counts built pages by type (prerendered HTML) and on-demand pages from the snapshot database.
# usage: page-counts.sh <web/dist> ; env DATABASE_URL
D="$1"
echo "type,count,source"
for t in fsc open group agency services guides supplier; do
  echo "$t,$(find "$D/$t" -name index.html 2>/dev/null | wc -l),prerendered html"
done
echo "top-level,$(find "$D" -maxdepth 2 -name index.html | wc -l),prerendered html"
psql "$DATABASE_URL" -At -F, -c "select 'nsn', count(*), 'on demand (pub.nsns)' from pub.nsns
 union all select 'solicitation', count(*), 'on demand (pub.solicitations)' from pub.solicitations
 union all select 'supplier detail', count(*), 'on demand (pub.suppliers)' from pub.suppliers"
