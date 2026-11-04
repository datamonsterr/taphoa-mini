#!/usr/bin/env bash
# Runs inside the emulator booted by reactivecircus/android-emulator-runner:
# install the release APK, grant the camera, run the Maestro flows, then check the jank budget.
# Usage: e2e-android.sh <apk> [flow...]
# RUN_TAG (optional, [a-z0-9-]) is passed to the flows as env, so sign-in.yaml tags its Clerk users.
# Each flow is a flow file or folder relative to apps/mobile; with none, the whole .maestro folder runs.
set -euo pipefail

apk="${1:?usage: e2e-android.sh <apk> [flow...]}"
shift
flows=("$@")
if [ "${#flows[@]}" -eq 0 ]; then flows=(.maestro); fi
# Resolve against the caller's directory before the cd below.
apk="$(realpath "$apk")"
app_id=com.datamonsterr.taphoamini
cd "$(dirname "$0")/.."

# Move the emulator onto the backend pinned business clock (scripts/e2e/pin-clock.sh), so both
# agree on today even when the run crosses 00:00 Asia/Ho_Chi_Minh. Needs root, which the
# google_apis image allows; fail loudly, since a silent mismatch reappears as a midnight flake.
if [ -n "${E2E_CLOCK_OFFSET_SECS:-}" ]; then
  adb root
  adb wait-for-device
  adb shell settings put global auto_time 0
  adb shell settings put global auto_time_zone 0
  target=$(($(date +%s) + E2E_CLOCK_OFFSET_SECS))
  adb shell "date -u $(date -u -d "@$target" +%m%d%H%M%Y.%S)" >/dev/null
  actual="$(adb shell date +%s | tr -d '\r')"
  drift=$((actual - target))
  echo "emulator clock: target=$target actual=$actual drift=${drift}s"
  if [ "${drift#-}" -gt 60 ]; then
    echo "could not set the emulator clock" >&2
    exit 1
  fi
fi

adb install -r "$apk"
adb shell pm grant "$app_id" android.permission.CAMERA
# The Pixel Launcher keeps hitting ANRs on the CI emulator and its system dialog covers the
# app mid-flow. Maestro launches the app by package, so the launcher is not needed.
adb shell settings put secure anr_show_background 0 || true
adb shell pm disable-user --user 0 com.google.android.apps.nexuslauncher || true

# Warm-up: the first cold start on a slow emulator takes minutes; pay it here, not in a real flow.
# The result is ignored on purpose; smoke runs again in the suite below.
maestro test .maestro/smoke.yaml || true

# Drop the warm-up frames so the budget only measures the suite.
adb shell dumpsys gfxinfo "$app_id" reset >/dev/null || true

# --debug-output keeps screenshots + logs for the artifact; flatten drops the per-run timestamp dirs.
# Keep the exit code: the jank report must still be produced when a flow fails.
maestro_status=0
tag_args=()
if [ -n "${RUN_TAG:-}" ]; then tag_args=(-e "RUN_TAG=$RUN_TAG"); fi
maestro test "${tag_args[@]}" "${flows[@]}" \
  --format junit --output maestro-report.xml \
  --debug-output maestro-debug --flatten-debug-output || maestro_status=$?

adb shell dumpsys gfxinfo "$app_id" >gfxinfo.txt || true
budget_status=0
node scripts/gfxinfo-budget.mjs gfxinfo.txt || budget_status=$?

if [ "$maestro_status" -ne 0 ]; then exit "$maestro_status"; fi
exit "$budget_status"
