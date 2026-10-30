# ADR 0008: Voice sales use one audio-native model call, no AccessibilityService

Status: Accepted (owner confirmed 2026-10-27) · Date: 2026-10-27 · Program: [voice](../specs/voice/README.md) · Amends the
"Voice" decision of the [assistant program](../specs/assistant/README.md)

## Context

The assistant program chose on-device speech recognition (`vi-VN`) and no server speech
model, because the chat microphone only dictates into a text box. The voice program adds a
different job: a seller says a sale ("một chai tương ớt hai mươi nghìn") from the home screen
or another app, and the app must get the product, the quantity and the price right in under
three seconds, then record the sale after one confirming tap. On-device recognition has no
catalog context and normalizes numbers inconsistently, and the free text models the assistant
uses have p95 latencies of 30 s or more (issue #58). The owner asked for a comparison of Fish
Audio, ElevenLabs, Vbee, Whisper and Gemini multimodal, picking the option that is cheap and
responsive for clips under 30 seconds; the comparison is in
[speech-options.md](../specs/voice/speech-options.md).

The owner also described the Android entry point as a button enabled from the accessibility
menu. On Android that is an `AccessibilityService`. Google Play allows the API in non-accessibility
apps only with an in-app prominent disclosure, a declaration form and a video, and Android 17
Advanced Protection can disable such services; a sales shortcut does not qualify as an
accessibility tool.

## Decision

- **One audio-native call.** The backend sends the recorded clip (AAC, at most 30 s) to
  `google/gemini-2.5-flash-lite` through the existing OpenRouter chat client with an
  `input_audio` part, a Vietnamese system prompt, a catalog hint (names and prices of up to
  300 recently sold products) and a JSON schema. The model returns the transcript and the
  parsed lines in one response. `VOICE_MODELS` is an ordered list; the next slug is tried on
  failure.
- **Fallbacks.** OpenRouter `/api/v1/audio/transcriptions` with `openai/whisper-large-v3-turbo`
  plus a text-only parse call when audio input fails; on-device `expo-speech-recognition` when
  the phone is offline or the server answers `503`. The chat microphone uses the server
  transcription path by default and the same fallbacks.
- **Confirm before write.** The parsed draft always shows on the voice sale sheet; Confirm
  records the sale through the existing cart, outbox and `POST /v1/sales` with
  `source=voice` lines. An unknown product warns on the sheet and is picked, added or removed before Confirm (updated for issue 152, 154).
- **Android entry point: overlay, not accessibility.** A floating bubble drawn with
  `SYSTEM_ALERT_WINDOW` from a foreground service of type `specialUse`, plus a Quick Settings
  tile. The bubble only launches the app's `/voice` route; recording happens in the
  foreground. No `AccessibilityService` is declared.
- **iOS entry points:** a Control Center control, the Action Button and a Siri App Intent that
  open the same route, built as an Apple target when an iOS build exists.
- **Retention.** Audio is discarded after the call; transcript, parsed JSON and outcome stay 30
  days; clips are kept only with the member's opt-in, for the voice golden set.

## Consequences

- About $0.0007 per utterance ($2 per active store per month at 100 a day); the assistant's
  OpenRouter keys need higher limits, and a separate per-store daily voice quota exists.
- Latency budget: record stop to draft under 3 s at p95; measured by e2e on Railway `test`.
- The native overlay module is Android-only Kotlin in the app (Expo Modules API) with a config
  plugin; it needs a development build, and the Play listing needs the "Hiện trên ứng dụng
  khác" rationale and the foreground service declaration.
- Server speech means an online dependency for the best accuracy; on-device remains for
  offline, so the app never loses the feature entirely.
- A model change is a variable change plus a voice golden-set run; the harness compares
  Gemini Flash-Lite generations, Whisper turbo and ElevenLabs Scribe on the same clips.
