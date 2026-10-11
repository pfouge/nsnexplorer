#!/usr/bin/env bash
# Usage: retry-pool-full.sh <log-file> <command...>
# Runs the command, teeing its output to <log-file>. If it fails because
# Supabase's session pooler was full (EMAXCONNSESSION, "max clients reached
# in session mode"), waits and tries again, up to 3 attempts in all.
# Any other failure returns at once with the command's exit code.
set -o pipefail
log="$1"; shift
for attempt in 1 2 3; do
  if "$@" 2>&1 | tee "$log"; then exit 0; else code=$?; fi
  if ! grep -qE 'EMAXCONNSESSION|max clients reached' "$log"; then exit "$code"; fi
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::Database connection limit reached (attempt $attempt of 3); retrying in ${RETRY_WAIT_SECONDS:-120} s"
    sleep "${RETRY_WAIT_SECONDS:-120}"
  fi
done
echo "::error::Database connection limit still reached after 3 attempts"
exit "$code"
