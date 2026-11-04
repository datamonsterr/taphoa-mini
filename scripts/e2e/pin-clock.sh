#!/usr/bin/env bash
# Picks the one business clock the Android E2E backend and emulator share, so a shard that runs
# across 00:00 Asia/Ho_Chi_Minh (17:00 UTC) never splits "today" between them.
#
# The backend pins to HH:MM (default 10:00, before the 20:00 day-close prompt) on the store date
# of *now*, then advances in real time. The emulator reports the real clock, so it must be moved
# by the same offset. This prints (append the output to $GITHUB_ENV):
#   TAPHOA_TEST_NOW=<RFC 3339 instant, +07:00>      for the backend (stack.sh up)
#   E2E_CLOCK_OFFSET_SECS=<pinned - real, seconds>  for apps/mobile/scripts/e2e-android.sh
# Both clocks advance at real speed, so the offset stays valid for the whole run.
# Usage: pin-clock.sh [HH:MM]
set -euo pipefail

pin="${1:-10:00}"
[[ "$pin" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "pin must be HH:MM: $pin" >&2; exit 1; }
tz=Asia/Ho_Chi_Minh
real="$(date +%s)"
day="$(TZ=$tz date -d "@$real" +%F)"
pinned="$(TZ=$tz date -d "$day $pin:00" +%s)"
echo "TAPHOA_TEST_NOW=$(TZ=$tz date -d "@$pinned" +%Y-%m-%dT%H:%M:%S%:z)"
echo "E2E_CLOCK_OFFSET_SECS=$((pinned - real))"
