# One-trip enrollment

Status: Behind a flag (`EXPO_PUBLIC_ONE_TRIP_ENROLL`, default off) · Roadmap R4 · Split from
draft PR #301 ([object capture](https://github.com/datamonsterr/taphoa-mini/pull/301)) · Date: 2026-11-25

## Goal

Enroll a new product in one trip: one shutter press takes the photos, then one spoken phrase
fills name and price, then save. Gates from #301's object-capture spec:

| #   | Gate                                                         | How it is read                                  |
| --- | ------------------------------------------------------------ | ----------------------------------------------- |
| C1  | Median of 10 timed enrollments on a mid-range Android ≤ 16 s | `enroll.one_trip_completed` log / PostHog event |
| C3  | Identify p95 shutter-to-result ≤ 8 s, WAN included           | `scan.tap_to_result` log / PostHog event        |

## Flow (flag on)

```
tag toggle on (purple)
  -> shutter once: 3 photos, 700 ms apart ("Xoay sản phẩm" strip hint)   [C1 clock starts]
       each photo, in the background: downsize 1024 -> POST /v1/images (enrollment)
         -> POST /v1/segment/points with one centre point -> accepted reference
       cut-outs run one at a time (the server has one inference slot) and retry a 503
  -> sheet opens right after the third photo; title counts references (0/3 .. 3/3)
  -> "Nói tên và giá": one phrase ("mì hảo hảo năm nghìn") -> POST /v1/voice/utterances
       mode=transcribe -> parsed on the phone into name and price -> form prefilled
     typing stays available; no-speech / failure says so and leaves the form editable
  -> "Lưu sản phẩm" -> POST /v1/products with the 3 references        [C1 clock stops]
```

With the flag off nothing changes: each shutter press takes one photo and opens the point
prompt (see `quick-enroll.md`). With the flag on, the point prompt is still used for extra angles
from the sheet's camera tile; the shutter starts a one-trip capture only while no shot is held.

## Decisions

- **Existing endpoints only.** No backend change, no new model. `#301` added a keyframe
  enrollment API (8–24 frames, farthest-point sampling, migration 1603), a `mode=product` voice
  parser (migration 1604) and SigLIP2 (about +355 MiB image, 1.34 GiB RSS). None is needed for the
  flow above; the references stay the 3..8 `references` payload the server already accepts.
- **Centre point instead of a tap.** The seller holds the product in the middle of the frame, so
  SAM is prompted at the photo centre. A photo whose cut-out fails is dropped and the seller is
  told to add an angle from the sheet.
- **Phone-side name/price split.** The server transcribes (`mode=transcribe`, already used by
  the chat microphone); `parseNamePrice` reads the trailing Vietnamese amount ("năm nghìn",
  "mười lăm nghìn", "hai chục", "15k", "12.000đ", "năm nghìn rưỡi"). A trailing number without a
  scale word stays in the name ("coca 330").
- **Not ported from #301:** live ML Kit object boxes and tracking, tap-a-box lock, auto keyframes
  by sharpness, coverage ring, spoken prompts, phone boxes in scans, kNN voting. They need a local
  native ML Kit object-detection module (R3 ships barcode and text only) and the retrieval v2 work.

## Instrumentation

- `enroll.one_trip_completed` `{duration_ms, shot_count, voice_used}`: `console.info` (logcat tag
  `ReactNativeJS`) and PostHog `one_trip_enrollment_completed`. Starts at the shutter press,
  stops when `POST /v1/products` returns; cancel, tag off and focus loss drop the clock.
- `scan.tap_to_result` `{duration_ms, ok, detection_count}`: `console.info` and PostHog
  `scan_tap_to_result` for every checkout scan (flag independent). Timeouts (20 s) and errors log
  `ok: false` and count in the p95.
- `apps/mobile/scripts/r4-gates.mjs <log>` reads both from a logcat dump and prints PASS/FAIL.

## Owner measurement (C1, C3)

1. Phone: a mid-range Android (for example Galaxy A15/A25 or Redmi Note 13 class, Android 13+),
   on the shop's normal Wi-Fi or 4G, battery saver off.
2. Build: `cd apps/mobile && npx eas-cli@latest build --profile measure --platform android`
   (the `test` backend plus `EXPO_PUBLIC_ONE_TRIP_ENROLL=1`; add `EXPO_PUBLIC_NATIVE_CAMERA=1`
   to the profile to measure on the R3 camera). Install the APK, sign in to a test store with
   enroll permission. The `test` backend must be up (roadmap U6).
3. Warm up: one scan, then wait 10 s.
4. C1: ten times, with a product you have not enrolled: tap the purple tag, press the shutter,
   turn the product slowly while the three photos are taken, tap "Nói tên và giá", say name and
   price once, check the form, tap "Lưu sản phẩm". Do not pause between steps.
5. C3: twenty checkout scans of enrolled products (mix of single and several items, near and
   far): press the shutter and wait for the price pill.
6. Read: `adb logcat -d -s ReactNativeJS:I > r4.log && node scripts/r4-gates.mjs r4.log`, run
   from `apps/mobile` with the phone on USB debugging (clear first with `adb logcat -c`). Or in
   PostHog (environment `test`): median of `one_trip_enrollment_completed.duration_ms`, p95 of
   `scan_tap_to_result.duration_ms`.
7. Post the script output and the phone model on the R4 issue.
