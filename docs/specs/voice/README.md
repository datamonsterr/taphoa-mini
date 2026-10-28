# Voice quick-sale and voice chat: program spec

Status: Accepted · Date: 2026-10-27 · ADR: [0008](../../adr/0008-voice-audio-native-model.md) ·
Tracker: GitHub issue #69 (epics #70-#76) · Builds on the
[assistant program](../assistant/README.md)

## Goal

Let a seller log a sale by speaking, from anywhere on the phone, without opening the app
first. On Android a floating microphone button (the **voice bubble**) sits over the home screen
and other apps; on iOS a Control Center control, the Action Button or Siri start the same flow.
The seller says something like _"một chai tương ớt hai mươi nghìn"_. The phone records at most
30 seconds, the backend sends the audio to one audio-native model that transcribes and parses
it in a single call, matches the products against the store catalog, and the app shows a
compact **voice sale sheet**. One tap on the green check records the sale through the existing
sale path, so stock moves and chốt sổ, reports and the assistant see it like any other sale.

The same server speech path upgrades the assistant chat microphone, so Vietnamese product
names and prices are heard correctly. On-device recognition stays as the offline fallback.

## Documents

| File                                                                                                   | Content                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [voice.md](voice.md)                                                                                   | Use cases, architecture, parsing rules, API contract, UI, entry points, privacy |
| [speech-options.md](speech-options.md)                                                                 | Vendor and model comparison with verified prices; the decision and fallbacks    |
| [epics.md](epics.md)                                                                                   | Epic briefs V0-V6: scope, owned files, tasks, acceptance, out of scope          |
| [play-console.md](play-console.md)                                                                     | Android bubble: Play Console texts and the real-device test script (V3)         |
| [DESIGN.md](../../design/DESIGN.md) · [canvas v0.2](https://claude.ai/artifact/4V8zoNh4hMuTNzxWNhV5q9) | Screens 14-17 (voice bubble, listening, voice sale sheet, chat listening)       |

## Definition of done (whole program)

| #   | Done when                                                                                                                                                                                                   | Proven by                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Android: after the one-time setup in Tài khoản, the voice bubble shows over the home screen and other apps; a tap opens the voice sale sheet in under 500 ms; after Confirm the previous app returns.       | Maestro on a real Android device + screen recording  |
| 2   | Voice sale: an utterance of at most 30 s becomes a draft with matched products, quantities and prices; release-to-draft p95 under 3 s on Railway `test`; Confirm records the sale and moves stock.          | Rust integration + e2e `voice.test.ts` + Maestro     |
| 3   | Unknown products become manual lines at the spoken price and reach the Lead review queue; ambiguous lines show up to three candidates; nothing is written before Confirm.                                   | Rust tests + Jest + golden set                       |
| 4   | Assistant chat microphone uses server transcription on Android and iOS, falls back to on-device recognition offline, and never sends by itself.                                                             | Jest + Maestro                                       |
| 5   | Voice golden set of at least 40 Vietnamese clips: line accuracy (product, quantity and price all right) at least 90 % and price accuracy at least 97 % on the default model; results in the repo + PostHog. | `pnpm --filter @taphoa/eval run voice` + PostHog     |
| 6   | Cost at most $0.002 per utterance on the default model; a per-store daily cap; cost per utterance visible in PostHog `$ai_generation`.                                                                      | PostHog insight + eval cost report                   |
| 7   | Audio is not stored after processing unless the member opted in; the app explains "Hiện trên ứng dụng khác" before asking; no AccessibilityService in the manifest.                                         | Code review + Play Console data-safety form          |
| 8   | iOS (when an iOS build exists): Control Center control, Action Button and Siri open the voice sale sheet.                                                                                                   | Manual check on a device, recorded in the DoD report |
| 9   | Every new span, log and event follows the [telemetry contract](../assistant/telemetry-contract.md); CI green; every epic PR merged; worktrees cleaned per `AGENTS.md`.                                      | Contract tests + `gh pr list --state merged`         |

The DoD report lives at `docs/specs/voice/dod-report.md` (written by the last epic).

## Settled decisions (confirmed by the owner on 2026-10-27; do not reopen)

- **Speech architecture (ADR 0008).** One audio-native model call through OpenRouter chat
  completions with `input_audio` and a JSON schema: `google/gemini-2.5-flash-lite` first,
  ordered list `VOICE_MODELS`. Fallback 1: OpenRouter `/api/v1/audio/transcriptions` with
  `openai/whisper-large-v3-turbo`, then the same model family parses the text. Fallback 2
  (offline or server error): on-device `expo-speech-recognition`, text parsed on the server
  when back online, or typed into the cart by hand. See [speech-options.md](speech-options.md).
- **No AccessibilityService.** The Android bubble uses the "Hiện trên ứng dụng khác"
  permission (`SYSTEM_ALERT_WINDOW`) and a foreground service, the same mechanism as chat
  heads. Google Play's AccessibilityService policy treats a sales shortcut as a non-accessibility
  use that needs a declaration form, a video and in-app disclosure, and Android 17 Advanced
  Protection can revoke it. A Quick Settings tile is the cheaper second entry point.
- **The bubble only launches the app.** Recording happens in the foreground `/voice` route, so
  microphone access needs no foreground-service exemption (Android 14 while-in-use rule).
- **Recording.** `expo-audio`, AAC in `.m4a`, 16 kHz mono, 32 kbps, at most 30 s
  (`forDuration`), auto-stop after 2 s of silence (metering), hold-to-talk inside the app and
  tap-to-start / tap-to-stop from the bubble (one hand, phone possibly on the counter).
- **Seller confirms every sale.** The sheet always shows before anything is written. The sale
  itself goes through the existing cart store, outbox and `POST /v1/sales`, with
  `source=voice` on each line.
- **Prices.** A spoken price wins and is stored as spoken (`price_mismatch` flags a catalog
  difference, as today). Without a spoken price the catalog price applies. An unknown product
  without a price asks for one on the keypad.
- **Unknown products** become manual lines (`source=manual`, `manual_label` = spoken words)
  and reach the review queue; the seller may pick a catalog product on the sheet instead.
- **Payment.** Default cash with change entry skipped; "chuyển khoản" opens the VietQR pay
  screen with the draft; "ghi nợ <tên>" makes a credit sale with customer matching.
- **In-app entry points follow the assistant rule "no new buttons":** long-press on the chat
  button opens the voice sale sheet; a `voice_sale` next-step chip teaches it for 14 days.
- **Chat microphone.** Server transcription by default on Android and iOS (fills the input,
  never sends); on-device fallback when offline or on `503`; web keeps the Web Speech API path.
- **Quota and billing.** Same OpenRouter keys as the assistant with raised limits;
  `VOICE_DAILY_UTTERANCES_PER_STORE` (default 300) separate from the assistant quota.
- **Retention.** Audio bytes are deleted right after the model call. Transcript, parsed JSON
  and the outcome stay 30 days in `voice_utterances` for debugging and evaluation. An opt-in
  switch in Tài khoản ("Góp giọng nói để cải thiện") keeps clips for the golden set.
- **Vbee** (Vietnamese speech vendor, no public API price) gets a quote and a bake-off only if
  the golden set shows the default model under the bar on Vietnamese product names.
- **Autonomy.** Same grants as the assistant program (push, PRs, merge after CI green + review,
  deploy `test`, variables). Store listing changes, Play declaration forms and iOS signing need
  the owner.

## Epic graph and waves

```
Wave 1:  V0 contract + spec ───────┬───────────────┬──────────────┐
         V6 design canvas + docs    │               │              │
Wave 2:  V1 backend voice (V0) ─────┤   V2 mobile voice core (V0) ─┤   V5 voice golden set (V0; final run needs V1)
Wave 3:  V3 Android entry points (V2)        V4 iOS entry points (V2, needs an iOS build)
Wave 4:  DoD report (all)
```

| Epic | Branch                        | Depends on (merged into `main`) | Migrations |
| ---- | ----------------------------- | ------------------------------- | ---------- |
| V0   | `epic/v0-voice-contract`      | none                            | none       |
| V6   | `epic/v6-voice-design`        | none                            | none       |
| V1   | `epic/v1-voice-backend`       | V0                              | `11xx`     |
| V2   | `epic/v2-voice-mobile`        | V0                              | none       |
| V5   | `epic/v5-voice-golden-set`    | V0 (final run needs V1)         | none       |
| V3   | `epic/v3-voice-android-entry` | V2                              | none       |
| V4   | `epic/v4-voice-ios-entry`     | V2 + an iOS development build   | none       |

The program controller starts each wave when its dependencies are merged, answers questions
from epic sessions, and runs nothing itself. The shared rules (controller model, TDD, docs
first, contract ownership, file ownership, migrations, e2e, telemetry, secrets, Railway `test`,
merging, reporting) are the ones in the
[assistant program README](../assistant/README.md#shared-rules-for-every-epic).

## Secrets and variables map

| Name                                   | Where                                    | Owner epic |
| -------------------------------------- | ---------------------------------------- | ---------- |
| `OPENROUTER_API_KEY`                   | Railway backend; exists; raise the limit | V1         |
| `VOICE_MODELS`                         | Railway backend, `.env.example`          | V1         |
| `VOICE_STT_MODEL`                      | Railway backend, `.env.example`          | V1         |
| `VOICE_DAILY_UTTERANCES_PER_STORE`     | Railway backend, `.env.example`          | V1         |
| `VOICE_MAX_SECONDS`, `VOICE_MAX_BYTES` | Railway backend, `.env.example`          | V1         |
| `EXPO_PUBLIC_VOICE_SERVER_CHAT`        | EAS (feature flag until PostHog flag)    | V2         |

## User inputs needed before wave 2

- Confirm the settled decisions above (model, no AccessibilityService, retention).
- Raise the OpenRouter per-environment key limits (currently $1 each) to cover
  roughly $2 per active store per month at 100 utterances a day.
- Play Console: approve the "Hiện trên ứng dụng khác" rationale text and the foreground
  service `specialUse` declaration (V3 writes both).
- iOS: an Apple developer account and an iOS development build if V4 is wanted this program.
