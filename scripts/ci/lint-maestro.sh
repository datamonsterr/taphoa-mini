#!/usr/bin/env bash
# Android keyboard detection can send Back and close a sheet. Use Enter or an explicit tap.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
flows="${1:-$repo/apps/mobile/.maestro}"
# Keep grep failures (missing/unreadable flow directory) distinct from a clean scan.
status=0
grep -rnF hideKeyboard "$flows" || status=$?
if [[ "$status" == 0 ]]; then
  echo 'Maestro: replace hideKeyboard with Enter or an explicit tap, then assert the sheet stays open.' >&2
  exit 1
fi
[[ "$status" == 1 ]]
