# Voice program epic briefs

Status: Proposed · Date: 2026-10-27 · Program: [README](README.md)

Each epic session is a controller (shared rules in the
[assistant program README](../assistant/README.md#shared-rules-for-every-epic)). It reads the
voice README, this file's section for its epic and [voice.md](voice.md), writes its task graph
into `docs/specs/voice/<epic>-plan.md`, then executes it. "Owns" lists the files the epic may
change; "Touches" lists agreed integration points it may edit minimally.

---

## V0 · Voice contract and shared interfaces

- **Status:** done on 2026-10-29, PR #103.
- **Branch:** `epic/v0-voice-contract` · **Depends:** none · **Wave:** 1 (merge first)
- **Goal:** land the API contract, schemas, telemetry rows and mock handlers so V1, V2 and V5
  run in parallel.
- **Owns:** voice section of `docs/api/openapi.yaml` (`/v1/voice/utterances`,
  `/v1/voice/utterances/{id}/outcome`, schemas `VoiceUtterance`, `VoiceSaleDraft`,
  `VoiceDraftLine`, `CustomerMatch`), `LineSource` `voice` value, `packages/api-client/**`
  (regenerate `schema.d.ts`, multipart helper for audio), voice handlers in
  `apps/mobile/src/test/mock`, product events and spans in
  `docs/specs/assistant/telemetry-contract.md`, `ProductEvent` variants in `analytics.rs`.
- **Tasks:** contract per voice.md "API contract"; mock handlers returning a canned draft for
  fixture bytes (two-line sale, unknown product, credit, `no_speech`, quota); fixture clips
  `packages/e2e/fixtures/voice/*.m4a` recorded by the owner (at least 10, with a transcript
  sidecar).
- **Acceptance (tests first):** `tests/contract.rs` passes with the new paths; api-client
  vitest covers the multipart helper; mobile Jest mock test for one drafted sale;
  `pnpm turbo run typecheck test` green.
- **User input:** the fixture clips (owner records on a phone in the shop).
- **Out of scope:** handler code, UI.

---

## V1 · Voice backend

- **Status:** done on 2026-10-29, PR #111. Default `VOICE_MODELS` is
  `google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite` (golden-set result in
  `packages/eval/results/voice-model-choice.md`); a server-side speech gate answers silence
  with `no_speech` before any model call.
- **Branch:** `epic/v1-voice-backend` · **Depends:** V0 · **Wave:** 2 · **Migrations:** `11xx`
- **Spec:** voice.md "Architecture", "Speech model request", "Catalog match", ADR 0008.
- **Owns:** new `apps/backend/crates/api/src/voice/**` (handlers, service, parse rules, catalog
  hint cache, match, aliases, quota, retention job, telemetry), audio support in the model
  client (`assistant/model/openrouter.rs`: content parts with `input_audio`, `response_format`
  JSON schema, `/audio/transcriptions` call; scripted client: audio fixtures), `11xx`
  migrations (`voice_utterances`, `voice_aliases`), `tests/voice*.rs`,
  `packages/e2e/tests/voice.test.ts`, voice variables in `.railway/railway.ts` and
  `.env.example`.
- **Touches:** `lib.rs` router merge; `sales` module only to accept `source=voice`
  (validation and the `voice_lines` event property); a read-only query in `products` for the
  catalog hint.
- **Tasks:** check current OpenRouter docs for `input_audio`, structured outputs and the STT
  endpoint (base64 JSON versus multipart, `usage.cost`); model call with ordered fallbacks;
  parse re-check rules as a pure module with the table in voice.md as unit tests; catalog
  hint (top 300 by 30-day sales, 5-minute cache per store); match bands and aliases; credit
  customer match reusing the debt book search; quota; outcome endpoint and alias learning;
  retention job (30 days, donated clips excluded); spans, `$ai_generation` with cost and
  product events per the contract; e2e with the fixture clips on Railway `test` including a
  latency gate (p95 under 3 s over at least 10 runs; the test samples 20).
- **Acceptance (tests first):** unit tests per rule and band; fallback-chain tests with the
  scripted client; `voice_quota` 429 test; retention test; span tests; e2e green on `test`;
  DoD rows 2, 3, 6.
- **User input:** OpenRouter key limits raised before the e2e task.
- **Out of scope:** UI, entry points, eval harness changes (V5).

---

## V2 · Voice mobile core

Status: done on 2026-10-29, PR #116

- **Branch:** `epic/v2-voice-mobile` · **Depends:** V0 · **Wave:** 2
- **Spec:** voice.md "Mobile UI", "Entry points" (in-app rows only), DESIGN.md screens 15-16.
- **Owns:** `apps/mobile/src/features/voice/**` (recorder hook on `expo-audio`, sheet,
  states, draft editing, cart hand-off, outcome posting, setup section components),
  `src/app/voice.tsx`, voice React Query hooks, strings, Jest tests, `.maestro/voice*.yaml`,
  `e2e-web/voice.spec.ts` (web shows the sheet with on-device recognition only), the chat
  `VoiceButton` server mode, `app.json` permission texts and the `expo-audio` plugin.
- **Touches:** `components/assistant/ChatButton.tsx` (`onLongPress`), `useNextStepChips.ts`
  (`voice_sale` rule, client-side), `features/account/AccountScreen.tsx` (section slot),
  `features/pay/PayScreen.tsx` (accept a draft from the cart, no change expected), root
  `_layout.tsx` (one route line), `features/assistant/chat/Composer.tsx` (placeholder state).
- **Tasks:** check current Expo SDK 58 docs for `expo-audio` recording options, metering and
  `forDuration`; recorder hook with permission, silence stop and cancel; the three sheet
  states; candidate strip reusing `AlternativesStrip` styles; price retype with the keypad;
  payment toggle and credit customer picker (reuse `CustomerPicker`); confirm paths (cash,
  transfer → `/pay`, credit); outcome calls; chat server mode behind the flag with the
  on-device fallback; Account setup section with platform-specific rows (the native toggles
  arrive in V3 and V4, so V2 ships the rows hidden behind capability checks); analytics calls.
- **Acceptance (tests first):** Jest for every component and the recorder hook against the
  mock; Playwright web flow (long-press chat button, see the sheet, fixture draft, confirm);
  Maestro Android flow with the debug fixture route; DoD row 4 and the app half of rows 2-3.
- **Out of scope:** native overlay, tile, Apple targets, backend.

---

## V3 · Android entry points

- **Branch:** `epic/v3-voice-android-entry` · **Depends:** V2 · **Wave:** 3
- **Spec:** voice.md "Entry points" Android rows, ADR 0008.
- **Owns:** local Expo Module `apps/mobile/modules/voice-bubble/**` (Kotlin: foreground
  service, overlay bubble, tile service, boot receiver, JS API `isSupported`, `canDrawOverlays`,
  `openOverlaySettings`, `start`, `stop`, `requestAddTile`, `moveTaskToBack`), its config
  plugin (permissions `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`; service and
  tile entries; static shortcut), the Account toggles wired to it, the Play Console texts in
  `docs/specs/voice/play-console.md`, Jest tests with a mocked module, a Maestro flow for the
  Account toggle, a manual test script for the bubble on a real device.
- **Tasks:** check current Android docs for `TYPE_APPLICATION_OVERLAY`, foreground service
  types on Android 14 and 15 (`specialUse` subtype property), background activity start rules
  (Android 15 needs a visible overlay), `TileService.requestAddTileService`; the bubble (56 dp,
  drag, edge snap, long-press hide, accessibility label); the notification with a stop action;
  deep-link launch with `FLAG_ACTIVITY_NEW_TASK`; return to the previous app after Confirm;
  boot restart when enabled; fingerprint change → new preview build through the existing
  EAS workflow.
- **Acceptance:** module unit tests (Kotlin) for state and intents; Jest for the JS wrapper and
  toggles; on a real device: bubble over the home screen and another app, tap → sheet in
  under 500 ms, Confirm → previous app; DoD rows 1 and 7; the data-safety and declaration
  texts reviewed by the owner.
- **User input:** owner approves the Play texts and tests on their phone.
- **Out of scope:** iOS, any `AccessibilityService`.

---

## V4 · iOS entry points (optional this program)

- **Branch:** `epic/v4-voice-ios-entry` · **Depends:** V2 and an iOS development build ·
  **Wave:** 3
- **Owns:** `apps/mobile/targets/voice-control/**` (Apple target via `expo-apple-targets`:
  `ControlWidget` button, App Intent opening the deep link, Siri phrase), its config in
  `app.json`, the Account instructions card, a manual test script.
- **Tasks:** check the current `expo-apple-targets` docs and iOS 18 control requirements;
  build the control and the intent; verify Action Button assignment and Siri; EAS iOS build.
- **Acceptance:** DoD row 8 on a device, recorded in the DoD report.
- **User input:** Apple developer account, signing in EAS.
- **Out of scope:** iOS overlays (none exist), widgets beyond the control.

---

## V5 · Voice golden set and evaluation

- **Status:** done on 2026-10-29, PR #122. 52 synthetic Vietnamese clips (two TTS voices, noise
  and silence cases) plus 10 e2e fixtures; final default-chain run: line 98.5 %, price 98.5 %,
  p95 3.0 s local, $0.0013 per utterance. Owner-recorded clips join with `"source": "recorded"`.
- **Branch:** `epic/v5-voice-golden-set` · **Depends:** V0 (final run needs V1) · **Wave:** 2
- **Spec:** [assistant golden-set.md](../assistant/golden-set.md) for the harness and PostHog
  scoring; this program adds audio cases.
- **Owns:** `packages/eval/golden/voice/**` (clips, sidecar JSON with expected transcript,
  lines, payment, customer), `packages/eval/src/voice/**` (runner calling
  `/v1/voice/utterances` on the eval store, scorers: transcript WER with Vietnamese
  normalization, line accuracy, price accuracy, quantity accuracy, latency, cost from
  `$ai_generation`), `packages/eval/results/voice-model-choice.md`, `eval.yml` voice job.
- **Tasks:** case design (at least 40 clips: single line, multi-line, price shorthand table,
  credit, transfer, noise, chat intent, nothing heard; two speakers, one phone on the counter);
  scorer unit tests first; runner with the quota guard; run per model (`VOICE_MODELS`
  candidates, Whisper turbo + parse, ElevenLabs Scribe + parse if a key is available); write
  the results file and set `VOICE_MODELS` on Railway from the result; smoke subset (10 clips)
  on each V1 PR.
- **Acceptance:** DoD row 5; the results file names the default and the fallbacks with
  numbers.
- **User input:** the clips (owner and one family member), an ElevenLabs trial key only if the
  bake-off is wanted.
- **Out of scope:** changing voice code (send findings to V1).

---

## V6 · Design canvas and docs

- **Branch:** `epic/v6-voice-design` · **Depends:** none · **Wave:** 1
- **Owns:** `docs/design/canvas/VoiceBubble.dc.html`, `VoiceListen.dc.html`, `VoiceSale.dc.html`,
  `ChatVoice.dc.html`, `FlowVoice.dc.html`, `VoiceSystem.dc.html`, `canvas.json`, DESIGN.md
  screens 14-17 and components, the Flow board update, the design canvas artifact
  (owner's claude.ai canvas) refresh.
- **Done on 2026-10-27:** canvas v0.2 (https://claude.ai/artifact/4V8zoNh4hMuTNzxWNhV5q9)
  holds boards 14-17 (bubble, listening, voice sale draft, chat listening), the voice flow board
  and the Account voice setup rows; `docs/design/canvas/` mirrors it.
- **Remaining boards done on 2026-10-28 (published as canvas version 31):**
  - [x] Understanding state: large grey transcript, progress line and cancel on `VoiceListen.dc.html`.
  - [x] Credit customer row: matched name or “Chọn khách”, using the 07b row on `VoiceSale.dc.html`.
  - [x] Android persistent notification with “Tắt”, Quick Settings tile and iOS Control Center
        control on `VoiceSystem.dc.html`; registered in `canvas.json`, documented in DESIGN.md.
- **Follow-up:** keep the canvas and DESIGN.md in sync as
  V1-V4 change the UI.
- **Acceptance:** boards open from `canvas.json`; DESIGN.md §3 lists 14-17 with controls;
  reviewed by the owner.
- **Out of scope:** app code.
