#!/usr/bin/env bash
# Builds the fake-camera clip for Playwright from a still photo. Chromium loops it as the webcam
# when PLAYWRIGHT_FAKE_VIDEO points at the result:
#
#   apps/mobile/e2e-web/fixtures/make-video.sh [photo] [out]
#   PLAYWRIGHT_FAKE_VIDEO=$PWD/apps/mobile/e2e-web/fixtures/product.mjpeg pnpm --filter @taphoa/mobile test:e2e:web
#
# Default photo: ONE product, the first (red) pack of the backend's shelf fixture, centred on the
# counter colour. Every frame of the clip is the same picture, so a scan is deterministic: the
# real SAM + DINO models cut the same crop each time, and a product enrolled from that crop
# matches the next scan at similarity ~1 (the backend threshold is 0.80, see
# apps/backend/crates/api/src/recognition/classify.rs).
#
# The still itself is kept as product.jpg: tests seed a product with it, and a scan of the camera
# picture matches that product.
#
# MJPEG instead of y4m: a few JPEG frames are under 1 MB where raw y4m would be tens of MB. The
# output is gitignored; CI regenerates it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
shelf="$here/../../../backend/tests/fixtures/shelf-1600.jpg"
out="${2:-$here/product.mjpeg}"

if [[ -n "${1:-}" ]]; then
  photo="$1"
else
  photo="$here/product.jpg"
  # crop: the red pack and a margin of counter; pad: back to 4:3 on the counter colour.
  ffmpeg -hide_banner -loglevel error -y -i "$shelf" \
    -vf "crop=190:290:60:40,scale=-2:760,pad=1280:960:(ow-iw)/2:(oh-ih)/2:color=0xCDBBA0" \
    -frames:v 1 "$photo"
fi

ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 10 -i "$photo" -frames:v 10 \
  -vf "scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2,format=yuvj420p" \
  -c:v mjpeg -q:v 3 -f mjpeg "$out"
ls -lh "$out"
