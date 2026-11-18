#!/usr/bin/env bash
# Commit one generated report file to main without ever failing the job.
#
#   bash .github/scripts/commit-report.sh <path> "<commit message>"
#
# The reports are diagnostics. Committing them with `git pull --rebase` failed whenever main had
# a newer copy of the same file: on every re-run (the checkout is the run's original commit) and
# when two jobs wrote the report close together. That turned a run whose data loaded into a
# failed run. This script puts the new report on top of the current main instead (no rebase, so
# no conflict), tries a few times if another push gets in first, and ends with a warning, not an
# error, if it still cannot push.
set -u
file="${1:?path of the report file}"
message="${2:?commit message}"

if [ ! -f "$file" ]; then echo "commit-report: $file does not exist; nothing to commit"; exit 0; fi
keep="$(mktemp)"
cp "$file" "$keep"
git config user.name "${REPORT_GIT_NAME:-dibbs-bot}"
git config user.email "${REPORT_GIT_EMAIL:-noreply@anthropic.com}"

for attempt in 1 2 3 4; do
  if git fetch -q origin main && git reset -q --hard FETCH_HEAD; then
    mkdir -p "$(dirname "$file")"
    cp "$keep" "$file"
    git add -- "$file"
    if git diff --cached --quiet; then echo "commit-report: no change"; exit 0; fi
    if git commit -q -m "$message" && git push -q origin HEAD:main; then
      echo "commit-report: pushed $file (attempt $attempt)"
      exit 0
    fi
  fi
  sleep $((attempt * 5 + RANDOM % 5))
done
echo "::warning::commit-report: could not push $file after 4 attempts; the run itself is unaffected"
exit 0
