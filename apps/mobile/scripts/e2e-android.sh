#!/usr/bin/env bash
# Runs inside the emulator booted by reactivecircus/android-emulator-runner:
# install the release APK, grant the camera, run every Maestro flow, then check the jank budget.
# Usage: e2e-android.sh <apk>
set -euo pipefail

apk="${1:?usage: e2e-android.sh <apk>}"
# Resolve against the caller's directory before the cd below.
apk="$(realpath "$apk")"
app_id=com.datamonsterr.taphoamini
cd "$(dirname "$0")/.."

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
maestro test .maestro \
  --format junit --output maestro-report.xml \
  --debug-output maestro-debug --flatten-debug-output || maestro_status=$?

adb shell dumpsys gfxinfo "$app_id" >gfxinfo.txt || true
budget_status=0
node scripts/gfxinfo-budget.mjs gfxinfo.txt || budget_status=$?

if [ "$maestro_status" -ne 0 ]; then exit "$maestro_status"; fi
exit "$budget_status"
