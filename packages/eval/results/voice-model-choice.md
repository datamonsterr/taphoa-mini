# Voice model choice

Status: **skeleton**. The controller fills the tables after the first real run against the V1
backend (epic V5, DoD rows 5 and 6). Nothing below the "Results" heading is measured yet.

## Method

- **Clips.** `golden/voice/` (52 clips, 10 of them tagged `smoke`) from the voice golden set: single
  and multi-line sales, the price shorthand rows of `docs/specs/voice/voice.md`, credit, transfer,
  chat intent, silence, unknown and ambiguous products, two speakers and shop noise. Clips are
  synthetic (`"source": "synthetic"`, OpenRouter TTS `microsoft/mai-voice-2.1-flash`, two voices)
  until the owner's recordings (`"source": "recorded"`) join them; report both sources
  separately once recordings exist, because synthetic speech is cleaner than a phone on a counter.
- **Run.** One run per candidate, same backend build, same eval store (`STORE.md`), one clip at a
  time (`concurrency 1`):

  ```sh
  pnpm --filter @taphoa/eval run voice -- --model <slug> --posthog-cost
  ```

  The backend needs an eval model override for `--model` (TODO in V1, see `src/voice/run.ts`);
  without it, set `VOICE_MODELS` to the candidate and run without `--model`. Results land in
  `results/voice-<date>-<model>.{json,md}` and in PostHog (`eval_voice_case_scored`,
  `eval_voice_run_completed`).

- **Metrics** (`src/voice/score.ts`): line accuracy (product, quantity and price all right),
  price, quantity, intent, payment and customer accuracy, transcript WER with Vietnamese
  normalization (lowercase, NFC, punctuation removed, diacritics kept) and the same with
  diacritics stripped, latency p50/p95 (client and server), cost per utterance (response, else
  PostHog `$ai_generation` by `$ai_session_id` = utterance id).
- **Bars** for the default model: line accuracy ≥ 90 %, price accuracy ≥ 97 %, cost ≤ $0.002 per
  utterance, latency p95 under 3 s.

## Candidates

| #   | Path                   | Slug / model                                           | Role                                                                             |
| --- | ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | Audio-native, one call | `google/gemini-2.5-flash-lite`                         | Default (ADR 0008)                                                               |
| 2   | Audio-native, one call | `google/gemini-3.1-flash-lite`                         | Next slug in `VOICE_MODELS`; check the slug is live on OpenRouter before the run |
| 3   | STT then text parse    | `openai/whisper-large-v3-turbo` + parse by candidate 1 | Fallback 2 (`stt_fallback = true`)                                               |
| 4   | STT then text parse    | ElevenLabs Scribe + parse                              | Only if a trial key exists and names miss the bar                                |

## Results

Run date: _TBD_ · backend commit: _TBD_ · clips: _TBD_ (synthetic _n_, recorded _n_)

| Metric                    | Bar       | 1 flash-lite | 2 next slug | 3 whisper + parse | 4 scribe + parse |
| ------------------------- | --------- | ------------ | ----------- | ----------------- | ---------------- |
| Line accuracy             | ≥ 90 %    | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Price accuracy            | ≥ 97 %    | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Quantity accuracy         |           | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Intent accuracy           |           | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Payment accuracy          |           | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| WER (diacritics kept)     |           | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| WER (diacritics stripped) |           | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Latency p50 / p95         | p95 < 3 s | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Cost per utterance        | ≤ $0.002  | _TBD_        | _TBD_       | _TBD_             | _TBD_            |
| Errors / not run          | 0         | _TBD_        | _TBD_       | _TBD_             | _TBD_            |

### Price shorthand rows (price accuracy by tag)

| Tag                                         | Clips | 1     | 2     | 3     | 4     |
| ------------------------------------------- | ----- | ----- | ----- | ----- | ----- |
| `price-chuc` (hai chục)                     | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `price-bare` (hai lăm, bare numbers)        | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `price-ruoi` (mười rưỡi, trăm rưỡi)         | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `price-tram` (hai trăm)                     | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `line-total` (line total versus unit price) | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| `noise`, `two-speakers`                     | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Decision

- Default (`VOICE_MODELS[0]`): _TBD_
- Fallbacks in order: _TBD_
- Railway variable to set: `VOICE_MODELS=` _TBD_
- Notes on failures worth sending to V1: _TBD_
