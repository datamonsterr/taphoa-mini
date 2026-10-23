#!/usr/bin/env bash
# Append a concise job summary: job-summary.sh <title> [detail...]
# Env: JOB_START (epoch seconds, set by the setup actions), JOB_STATUS (${{ job.status }}).
# Writes to $GITHUB_STEP_SUMMARY when set, otherwise stdout.
set -euo pipefail
title="${1:?title required}"
shift || true
now="$(date +%s)"
elapsed=$((now - ${JOB_START:-$now}))
{
  echo "### ${title}"
  echo
  echo "- status: **${JOB_STATUS:-unknown}**"
  echo "- duration: ${elapsed}s"
  for detail in "$@"; do
    echo "- ${detail}"
  done
  echo
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
