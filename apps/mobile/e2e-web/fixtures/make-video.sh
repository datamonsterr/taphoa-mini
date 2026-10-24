#!/usr/bin/env bash
# Builds the fake-camera clip for Playwright from a still photo. Chromium loops it as the webcam
# when PLAYWRIGHT_FAKE_VIDEO points at the result:
#
#   apps/mobile/e2e-web/fixtures/make-video.sh [photo] [out]
#   PLAYWRIGHT_FAKE_VIDEO=$PWD/apps/mobile/e2e-web/fixtures/product.mjpeg pnpm --filter @taphoa/mobile test:e2e:web
#
# Default photo is the backend's shelf fixture (18 products on a counter). MJPEG instead of
# y4m: a few JPEG frames are under 1 MB where raw y4m would be tens of MB. The output is
# gitignored; CI regenerates it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
photo="${1:-$here/../../../backend/tests/fixtures/shelf-1600.jpg}"
out="${2:-$here/product.mjpeg}"
ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 10 -i "$photo" -frames:v 10 \
  -vf "scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2,format=yuvj420p" \
  -c:v mjpeg -q:v 3 -f mjpeg "$out"
ls -lh "$out"
