#!/usr/bin/env bash
# Full before/after comparison against a frozen local database.
# usage: run.sh <baseline_checkout> <changed_checkout> <work_dir>
# env DATABASE_URL = the LOCAL snapshot database (never the production database); it is written to
# by the signup-form check, which is why it is a throwaway copy.
set -uo pipefail
A="$1"; B="$2"; W="$3"; HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$W"; : > "$W/summary.md"
say(){ echo "$@" | tee -a "$W/summary.md"; }
export WRANGLER_SEND_METRICS=false

for d in "$A" "$B"; do
  n="$(basename "$d")"
  (cd "$d" && npm ci --no-audit --no-fund > "$W/npm-$n.log" 2>&1 && npm run build --workspace=web > "$W/build-$n.log" 2>&1) || { say "BUILD FAILED in $n"; tail -30 "$W/build-$n.log"; exit 1; }
  say "built $n: $(find "$d/web/dist" -name '*.html' | wc -l) html files"
done

up(){ # dir port name
  (cd "$1/web" && setsid nohup npx wrangler pages dev dist --port "$2" --ip 127.0.0.1 --compatibility-date=2025-04-01 \
     --compatibility-flag=nodejs_compat --binding "DATABASE_URL=$DATABASE_URL" </dev/null > "$W/serve-$3.log" 2>&1 &)
  for i in $(seq 1 90); do curl -sf -o /dev/null "127.0.0.1:$2/about/" && return 0; sleep 2; done
  say "SERVER $3 did not start"; tail -40 "$W/serve-$3.log"; return 1
}
up "$A" 8101 a || exit 1
up "$B" 8102 b || exit 1

# Routes cover every page type; the data-dependent ones are looked up in the snapshot, using the baseline server.
node "$HERE/make-routes.mjs" http://127.0.0.1:8101 "$HERE/routes.base.txt" "$W/routes.txt" | tee -a "$W/summary.md"
export VR_ROUTES_FILE="$W/routes.txt"

shoot(){ # url out
  local pids=()
  for w in 390 1100 1366 1440; do
    VR_WIDTH=$w python3 "$HERE/shoot.py" "$1" "$2" shots >> "$W/shoot.log" 2>&1 & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || say "shoot failed: $1 $2"; done
}
shoot http://127.0.0.1:8101 "$W/a1"
shoot http://127.0.0.1:8101 "$W/a2"
shoot http://127.0.0.1:8102 "$W/b"
for x in "a1 8101" "a2 8101" "b 8102"; do set -- $x
  python3 "$HERE/shoot.py" http://127.0.0.1:$2 "$W/$1" boxes,forced >> "$W/shoot.log" 2>&1 &
done; wait
python3 "$HERE/shoot.py" http://127.0.0.1:8101 "$W/a1" behave >> "$W/shoot.log" 2>&1
python3 "$HERE/shoot.py" http://127.0.0.1:8102 "$W/b" behave >> "$W/shoot.log" 2>&1
echo "--- shoot.log tail"; tail -25 "$W/shoot.log"

say ""; say "## Noise floor: baseline vs baseline (must be 0 differing)"; say '```'
python3 "$HERE/diff.py" "$W/a1" "$W/a2" | tail -40 | tee -a "$W/summary.md"
python3 "$HERE/diff.py" "$W/a1/forced" "$W/a2/forced" | tail -10 | tee -a "$W/summary.md"
python3 "$HERE/boxdiff.py" "$W/a1/boxes.json" "$W/a2/boxes.json" | tail -20 | tee -a "$W/summary.md"
say '```'; say "## Baseline vs changed: pixels (default settings)"; say '```'
python3 "$HERE/diff.py" "$W/a1" "$W/b" "$W/diff" | cut -c1-400 | tail -150 | tee -a "$W/summary.md"
say '```'; say "## Baseline vs changed: forced-colors emulation (differences expected from the Part 2 forced-colors fixes)"; say '```'
python3 "$HERE/diff.py" "$W/a1/forced" "$W/b/forced" "$W/diff-forced" | tail -30 | tee -a "$W/summary.md"
say '```'; say "## Baseline vs changed: layout boxes (motion on, 390/768/1440)"; say '```'
python3 "$HERE/boxdiff.py" "$W/a1/boxes.json" "$W/b/boxes.json" | tail -90 | tee -a "$W/summary.md"
say '```'; say "## Page width == viewport, console errors, behaviour"; say '```'
python3 - "$W" <<'PY' | tee -a "$W/summary.md"
import json, glob, sys
W = sys.argv[1]
for side in ('a1', 'b'):
    rep = {}
    for f in glob.glob(f'{W}/{side}/report*.json'): rep.update(json.load(open(f)))
    over = {k: (v['sw'], v['iw']) for k, v in rep.items() if v['sw'] != v['iw']}
    errs = {k: v['errors'] for k, v in rep.items() if v['errors']}
    print(side, 'pages:', len(rep), 'overflowing:', over or 'none', 'console errors:', json.dumps(errs)[:1500] if errs else 'none')
a, b = json.load(open(f'{W}/a1/behave.json')), json.load(open(f'{W}/b/behave.json'))
for k in a:
    if k == 'analytics': continue
    print('behaviour', k, 'SAME' if a[k] == b.get(k) else f'DIFFERENT\n  A {json.dumps(a[k])[:900]}\n  B {json.dumps(b.get(k))[:900]}')
print('behaviour detail (changed build):', json.dumps({k: v for k, v in b.items() if k != 'analytics'})[:3500])
for sc in b['analytics']:
    for r, v in b['analytics'][sc].items():
        w = a['analytics'][sc][r]
        print('analytics', sc, r, 'page_views A/B', w['page_views'], v['page_views'], 'config calls', w['config_calls'], v['config_calls'], 'consent cmds B', v['consent_commands'], 'gcs B', [h['gcs'] for h in v['hits']][:3], 'csp errors B', v['csp_errors'])
PY
say '```'
(cd "$B" && node web/scripts/verify-no-ads.mjs web/dist) | tee -a "$W/summary.md"
pkill -f '[w]rangler' || true; pkill -f '[w]orkerd' || true
