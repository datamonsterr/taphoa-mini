#!/usr/bin/env bash
# Runs inside the emulator booted by reactivecircus/android-emulator-runner, with Metro already
# serving on the host at :8081: install Expo Go for this project's SDK, open the dev server
# URL in it, and run the Maestro preview flow.
# Usage: e2e-expo-go.sh
set -euo pipefail

cd "$(dirname "$0")/.."
expo_go=host.exp.exponent

# Same lookup `expo start --android` uses (@expo/cli downloadExpoGoAsync): the versions
# endpoint lists the official Expo Go APK per SDK in sdkVersions[<sdk>].androidClientUrl.
sdk="$(node -p "require('expo/package.json').version.split('.')[0] + '.0.0'")"
apk_url="$(curl -fsSL https://api.expo.dev/v2/versions/latest |
  node -e "const v=JSON.parse(require('fs').readFileSync(0,'utf8')).data.sdkVersions[process.argv[1]]; if(!v||!v.androidClientUrl) process.exit(1); console.log(v.androidClientUrl)" "$sdk")"
echo "Expo Go for SDK $sdk: $apk_url"
curl -fsSL --retry 3 -o expo-go.apk "$apk_url"
adb install -r -g expo-go.apk
# `install -g` skips permissions Expo Go does not declare, so grant the camera explicitly:
# without it the app shows "Cho phép máy ảnh để quét hàng" and the capture steps cannot run.
adb shell pm grant "$expo_go" android.permission.CAMERA

# Same launcher workaround as e2e-android.sh.
adb shell settings put secure anr_show_background 0 || true
adb shell pm disable-user --user 0 com.google.android.apps.nexuslauncher || true

# 10.0.2.2 is the emulator's alias for the host loopback.
adb shell am start -a android.intent.action.VIEW -d exp://10.0.2.2:8081 "$expo_go"

maestro test .maestro/expo-go/preview.yaml \
  --format junit --output maestro-expo-go-report.xml \
  --debug-output maestro-expo-go-debug --flatten-debug-output
