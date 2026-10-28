# Voice model choice

Status: **measured 2026-10-29** on a local stack (V1 backend, real OpenRouter models), 52 synthetic
clips. Candidate 4 (Scribe) was not run. Numbers below the "Results" heading come from the
`*-final` files in this folder; see "Run notes" for what that means.

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

Run date: 2026-10-29 · backend: `epic/v1-voice-backend` @ `1076855`, debug build, local stack
(`packages/eval/scripts/local-stack.sh` from the V1 checkout; Postgres 55432, Redis db 7) · clips: 52
(synthetic 52, recorded 0) · machine in Vietnam, so latency here is a worst-case WAN number; Railway
test latency is measured separately by the e2e gate. OpenRouter spend for the whole session: about
$0.15 of the $1 key.

Candidate 3 is **not exactly** the planned "whisper + parse by candidate 1": the backend parses the
transcript with the same `VOICE_MODELS` slug it tried for audio, so an audio-capable slug cannot
be forced to fail while still parsing. The run used `VOICE_MODELS=openai/gpt-4.1-mini` (a text model:
every audio call is refused as `unavailable`, then `openai/whisper-large-v3-turbo` transcribes, then
gpt-4.1-mini parses). 49 of 52 clips took that path; 3 were silence or an empty transcript
(`no_speech`). Treat column 3 as "a generic STT then text parse", not as the gemini fallback.

| Metric                                  | Bar       | 1 gemini-2.5-flash-lite | 2 gemini-3.1-flash-lite | 3 whisper + gpt-4.1-mini | 4 scribe + parse |
| --------------------------------------- | --------- | ----------------------- | ----------------------- | ------------------------ | ---------------- |
| Line accuracy (as the scorer defines)   | >= 90 %   | 89.4 %                  | **30.3 %** (see below)  | **28.8 %** (see below)   | not run          |
| Price accuracy (as the scorer defines)  | >= 97 %   | 90.9 %                  | **30.3 %** (see below)  | **28.8 %** (see below)   | not run          |
| Line accuracy, price by value (approx.) | >= 90 %   | 86.4 %                  | 95.5 %                  | 86.4 %                   | not run          |
| Price accuracy, by value (approx.)      | >= 97 %   | 92.4 %                  | 98.5 %                  | 90.9 %                   | not run          |
| Quantity accuracy                       |           | 95.5 %                  | 100 %                   | 95.5 %                   | not run          |
| Intent accuracy                         |           | 100 %                   | 96.2 %                  | 98.1 %                   | not run          |
| Payment accuracy                        |           | 97.9 %                  | 100 %                   | 97.9 %                   | not run          |
| WER (diacritics kept)                   |           | 15.0 %                  | 11.6 %                  | 26.6 %                   | not run          |
| WER (diacritics stripped)               |           | 14.8 %                  | 11.6 %                  | 25.7 %                   | not run          |
| Latency p50 / p95 (client, local)       | p95 < 3 s | 3.80 s / 5.10 s         | 2.03 s / 2.99 s         | 3.73 s / 4.94 s          | not run          |
| Cost per utterance                      | <= $0.002 | $0.00027 (40 priced)    | $0.00127 (40 priced)    | $0.00056 (41 priced)     | not run          |
| Errors / not run (final)                | 0         | 0 / 0 (7 after rerun)   | 0 / 0 (1 after rerun)   | 0 / 0                    | not run          |

"By value (approx.)": a line counts as right when the product, quantity and unit price are right and
an unpriced line carries the catalog price whatever `price_source` says; lines paired by position.
This is an analysis aid, not a scorer metric. Cost comes from PostHog `$ai_total_cost_usd`
(`--posthog-cost`); 11 to 12 clips per run had no priced generation event in time, so cost is the mean
of the priced ones.

### Why columns 2 and 3 fail the scorer

The scorer requires a line with no spoken price to have `price_source != "spoken"` (the price must
come from the catalog). Candidates 2 and 3 return a `unit_price` equal to the catalog price for
every unpriced line and the backend labels it `spoken`. The money is the same, but the draft says
the seller named a price nobody said, so the V1 price rule is bypassed. This is a **backend/prompt
issue, not a harness bug** (details in "Backend issues"). Candidate 1 does not do it (0 of 42 unpriced
lines marked `spoken`).

### Price shorthand rows (price accuracy by tag, scorer definition)

| Tag                                         | Clips | 1     | 2     | 3     | 4       |
| ------------------------------------------- | ----- | ----- | ----- | ----- | ------- |
| `price-chuc` (hai chục)                     | 1     | 1/1   | 1/1   | 1/1   | not run |
| `price-bare` (hai lăm, bare numbers)        | 2     | 2/2   | 2/2   | 2/2   | not run |
| `price-ruoi` (mười rưỡi, trăm rưỡi)         | 2     | 2/2   | 2/2   | 2/2   | not run |
| `price-tram` (hai trăm)                     | 1     | 0/1   | 1/1   | 1/1   | not run |
| `line-total` (line total versus unit price) | 2     | 1/2   | 2/2   | 2/2   | not run |
| `price-shorthand` (all 19 priced lines)     | 19    | 15/19 | 18/19 | 17/19 | not run |
| `noise` (5 lines)                           | 5     | 4/5   | 1/5   | 1/5   | not run |
| `two-speakers` (5 lines)                    | 4     | 4/5   | 0/5   | 0/5   | not run |

Spoken prices are handled well by all three; the loss in columns 2 and 3 is the unpriced lines above.

## Run notes

- Files: `voice-2026-10-29-<model>.{json,md}` are the raw full runs (52 clips, `concurrency 1`,
  `--posthog-cost`, one stack, one store). `results/rerun*/` hold re-runs of clips that failed with an
  upstream error. `voice-2026-10-29-<model>-final.{json,md}` merge those re-runs into the raw run and
  re-score everything against the current sidecars (`scripts/voice-merge.ts`). The table above is the
  `-final` set.
- Upstream reliability, candidate 1: the raw run had 7 `voice_unavailable` (OpenRouter/Google
  `rate_limited`, 10 audio and 7 text-fallback attempts, one `timeout`), mostly in the last 8 clips,
  and a re-run of the 7 still lost 2 (49, 50) until a later attempt. Four clips of the final set were
  answered by the STT fallback because the audio call was rate limited. Candidate 2 had one timeout
  (05, answered on retry, but wrong). With a single model in `VOICE_MODELS` a 429 is a user-visible
  failure; two entries in the list matter.
- Harness fix made during this run: sidecar `41-unknown-rau` expected an unknown product, but the eval
  store sells `Rau muống bó`. It now expects that product and the `unknown` tag is gone;
  `cases.test.ts` has a new test that no `unknown` line names a product in `STORE.md`. All numbers
  above use the fixed sidecar.
- Silence and noise-only clips (`39`, `40`): candidate 1 and 3 answer `none`; candidate 2 returns a
  3-line sale copied from the prompt's example (see below).

## Failures

Candidate 1 (`gemini-2.5-flash-lite`, final set):

| Case                           | What went wrong                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `15-multi-drinks`              | "ba lon Coca" parsed with quantity 1                                              |
| `22-price-hai-tram`            | transcript ends at "một hộp sữa bột": price and name tail dropped                 |
| `26-price-line-total-mismatch` | "hảo hảo hảo" split into two lines, 4 500 and 15 000; one extra line              |
| `29-credit-lan-nuoc-mam`       | "sáu chục" priced as 2 000 (spoken); customer chị Lan not linked                  |
| `32-credit-mai`                | "bán chịu cô Mai" returned as cash with no customer                               |
| `45-ambiguous-bia`             | heard "hai bó hành lá": matched `Hành lá bó`, one extra line                      |
| `46-two-speakers-sale`         | "hai lọn có ca" (Coca mis-heard) and the second speaker's line merged; extra line |
| `50-noise-price`               | same truncation as 22 ("Dielac Alpha Go"), price lost                             |

Candidate 2 (`gemini-3.1-flash-lite`), apart from the price-source issue: `05-single-trung` ("10 quả
trứng gà" for "mười quả trứng", product not matched), `39-silence` and `40-noise-only` (sale with 3
lines taken from the prompt example "2 lon bia Tiger, 1 gói mì Hảo Hảo tôm chua cay"), `43-unknown-mixed`
(unknown cosmetics line wrongly matched), `44-ambiguous-hao-hao` ("3 gói mì Hảo Hảo" resolved to one
product instead of ambiguous).

Candidate 3: `01-single-coca` (Whisper returned an empty text, `no_speech`), `44-ambiguous-hao-hao`,
`46-two-speakers-sale` (Whisper hallucinated "Hãy subscribe cho kênh Ghiền Mì Gõ" for the second
speaker), WER 26.6 % (the worst), plus the price-source issue. `39` and `40` correctly `none`.

## Decision

- Default (`VOICE_MODELS[0]`): **`google/gemini-3.1-flash-lite`**, but only after V1 fixes the two backend
  issues below. As deployed today it fails the scorer (30 % lines) and answers silence with an invented
  sale; by value it meets the bars (95.5 % lines, 98.5 % price, $0.00127, p95 2.99 s locally).
- If V1 cannot ship the fixes before the first Railway run: `google/gemini-2.5-flash-lite` first. It is
  the only candidate that passes the strict price-source rule and handles silence, but it misses the
  bars (89.4 % lines, 90.9 % price, p95 5.1 s locally) and rate-limits under sequential load.
- Fallbacks in order: the other gemini slug, then STT (`openai/whisper-large-v3-turbo`) with the parse
  slug. Keep both gemini slugs in the list so a 429 on one does not become `voice_unavailable`.
- Railway variable to set: `VOICE_MODELS=google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite`
  (after the V1 fixes; until then swap the order).
- Not decided: ElevenLabs Scribe (no key); recorded clips (all 52 are synthetic, expect worse on a
  phone at a counter).

## Backend issues (for V1, not changed here)

1. **Unpriced lines marked `spoken`** (`gemini-3.1-flash-lite` 45 of 47, `gpt-4.1-mini` 44 of 46 unpriced
   lines). Example, `02-single-lavie` ("một chai nước suối lavie"): the model returned `unit_price`
   5000 and the draft line is `{"price_source":"spoken","unit_price":5000,"status":"matched","quantity":1}`
   while `gemini-2.5-flash-lite` returns `"price_source":"catalog"` for the same clip. The backend should
   accept a model price only when the transcript contains a number or shorthand that explains it, or the
   prompt should say "price only if spoken".
2. **Silence and noise answered with the prompt example** (`gemini-3.1-flash-lite`, `39-silence`,
   `40-noise-only`): `intent=sale`, transcript "Cho mình 2 lon bia Tiger, 1 gói mì Hảo Hảo tôm chua
   cay...". The example in the system prompt leaks into the output when there is no speech. The backend
   should not trust a sale whose audio is silent or reject it by `confidence`.
3. **Model rate limit**: with one slug, OpenRouter 429s surface as `voice_unavailable` (7 of 52 clips for
   `gemini-2.5-flash-lite` at sequential speed). A second audio slug or a retry-after would absorb it.
4. **STT fallback parse uses the audio slugs** (design note): there is no separate `VOICE_PARSE_MODELS`, so
   the fallback path cannot be pointed at a different parser than the audio models.
5. Smaller: `X-Taphoa-Eval-Model` works (`--model` was honored for both gemini slugs); a 404-class refusal for
   a text-only audio model reports as `unavailable`, which is right.
