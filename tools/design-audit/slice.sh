#!/usr/bin/env bash
# Writes a slice of the frozen snapshot for local layout work: every small table whole, the big tables cut
# to a handful of supply classes (heavy and light), all open solicitations. No signups (PII).
# usage: slice.sh <out.sql.gz> ; env DATABASE_URL (the local snapshot, never production)
set -euo pipefail
OUT="$1"
FSCS="'5330','5331','5310','5305','5340','4730','5306','2530','6145','1680','4820','5961'"
P="psql $DATABASE_URL -v ON_ERROR_STOP=1 -At"
TMP=$(mktemp -d)
q() { # table where
  echo "\\echo copying $1"
  echo "COPY pub.$1 FROM STDIN;"
  $P -c "COPY (select * from pub.$1 where $2) TO STDOUT"
  echo '\.'
}
{
  echo "SET session_replication_role = replica;"
  for t in fsc agencies suppliers supplier_sam supplier_web supplier_stats supplier_optouts flis_codes inc_colloquial_names daily_stats; do q $t "true"; done
  q nsns "fsc in ($FSCS) or nsn in (select nsn from pub.solicitations where status='open' and nsn is not null)"
  SL="(select nsn from pub.nsns where fsc in ($FSCS) or nsn in (select nsn from pub.solicitations where status='open' and nsn is not null))"
  q solicitations "status='open' or fsc in ($FSCS) or nsn in $SL"
  for t in part_numbers nsn_management moe_rules amsc_observations nsn_identification nsn_standardization price_points; do q $t "nsn in $SL"; done
  q nsn_cancellations "true"
  q contract_actions "psc in ($FSCS)"
} | gzip -6 > "$OUT"
ls -l "$OUT" | awk '{print "slice bytes:", $5}'
