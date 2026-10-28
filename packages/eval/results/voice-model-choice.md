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

## Results, round 1 (V1 at `1076855`, before the fixes)

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

### Round 1 run notes

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

### Round 1 failures

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

## Results, round 2 (after the V1 fixes, `5daa12f`)

Same procedure and stack as round 1 (local, debug build, 52 synthetic clips, `concurrency 1`,
`--posthog-cost`), backend `epic/v1-voice-backend` @ `5daa12f`. Files are in `results/round2*/`; they
are raw runs (no re-run merge, no `-final`). Spend for the round: about $0.18 (key total $0.33 of $1).

| Metric                            | Bar       | A default chain (3.1, then 2.5) | B `--model` 2.5-flash-lite | C `--model` 3.1-flash-lite | D whisper, parse 2.5 |
| --------------------------------- | --------- | ------------------------------- | -------------------------- | -------------------------- | -------------------- |
| Line accuracy                     | >= 90 %   | **100 %**                       | 74.2 % (5 errors)          | **100 %**                  | 56.1 % (14 errors)   |
| Price accuracy                    | >= 97 %   | **100 %**                       | 74.2 %                     | **100 %**                  | 57.6 %               |
| Quantity accuracy                 |           | 100 %                           | 78.8 %                     | 100 %                      | 62.1 %               |
| Intent accuracy                   |           | 96.2 %                          | 90.4 %                     | 96.2 %                     | 73.1 %               |
| Payment accuracy                  |           | 100 %                           | 87.2 %                     | 100 %                      | 70.2 %               |
| WER (kept / stripped)             |           | 9.6 % / 9.6 %                   | 13.0 % / 13.0 %            | 10.1 % / 10.1 %            | 29.4 % / 28.4 %      |
| Latency p50 / p95 (client, local) | p95 < 3 s | 1.92 s / 2.79 s                 | 3.58 s / 4.98 s            | 1.91 s / 2.81 s            | 3.41 s / 5.75 s      |
| Cost per utterance                | <= $0.002 | $0.00080 (40 priced)            | $0.00030 (38 priced)       | $0.00080 (41 priced)       | $0.00030 (31 priced) |
| Errors                            | 0         | 0                               | 5 (all rate limits)        | 0                          | 14 (rate limits)     |
| Cases not exactly right           |           | 2 (`39`, `40`)                  | 13                         | 2 (`39`, `40`)             | 20                   |

A and C are the same model for all 52 clips (the chain never needed its second entry), so the
price-provenance fix and the `price_spoken` rule work: line and price accuracy went from 30 % to 100 %
and cost per utterance fell from $0.00127 to $0.00080. D is the STT path as originally planned: gpt-4.1-mini
refuses audio, so Whisper transcribes (36 clips answered, `stt_fallback=true`) and gemini-2.5-flash-lite parses.

Remaining failures:

- A and C, `39-silence` and `40-noise-only`: still `201 intent=sale` with an invented 3-line sale
  copied from the prompt example ("Cho mình lấy 2 lon bia Tiger, 1 gói mì Hảo Hảo tôm chua cay, với 1 chai
  nước suối Lavie nhé", lines priced from the catalog). The silence guard did not stop 3.1. The same clips
  return `no_speech` (422) with 2.5 and with Whisper. These two clips cost 6 hallucinated lines and
  3.8 points of intent accuracy; they would put a made-up sale on a counter whenever the shop is quiet.
- B (2.5 only): `voice_unavailable` on `11`, `12`, `42`, `43`, `44` (OpenRouter `rate_limited` after the
  retry; 12 audio and 9 text 429s, one text timeout). With `--model` the chain has one entry, so the retry
  is all there is. Wrong answers: `01-single-coca` ("hai lon ca"), `22-price-hai-tram` and `23-price-bare`
  (spoken price dropped from the transcript), `26-price-line-total-mismatch` ("hảo hảo hảo hảo", extra line),
  `32-credit-mai` (cash instead of credit), `45-ambiguous-bia` (invented "Hà Nội"), `46-two-speakers-sale`
  and `48-two-speakers-sauce` (mis-heard product, extra line).
- D: 14 `voice_unavailable` on `01`-`04`, `12`-`17`, `30`-`33` (the 2.5 parse model rate-limited in bursts,
  no second parse model was set in this run), plus Whisper errors: `46` (hallucinated "Hãy subscribe cho
  kênh Ghiền Mì Gõ"), `44`, `20`, `22`, `26`, `50` (numbers and brand names mis-heard).

## Decision

- Default (`VOICE_MODELS[0]`): **`google/gemini-3.1-flash-lite`**. After the V1 fixes it scores 100 % lines and
  prices, $0.0008 per utterance, p50 1.9 s and p95 2.8 s from Vietnam, with no errors in two full runs.
- Fallback: `google/gemini-2.5-flash-lite` (cheaper at $0.0003, but slower at p95 5 s locally, rate limits
  under load, and 74 % lines on its own in round 2). Then STT (`openai/whisper-large-v3-turbo`) with
  `VOICE_PARSE_MODELS`; Whisper is the weakest on names and numbers.
- Railway variables: `VOICE_MODELS=google/gemini-3.1-flash-lite,google/gemini-2.5-flash-lite`,
  `VOICE_PARSE_MODELS=google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite` (the V1 defaults).
- **Open before ship:** the silence guard (`39-silence`, `40-noise-only` answered with an invented sale by
  3.1). The line and price bars hold only because these two clips have no expected lines; the intent
  failure is real.
- Not decided: ElevenLabs Scribe (no key); recorded clips (all 52 are synthetic).

## Backend issues (round 1, for V1)

Items 1 (price provenance) and 3 (rate limit retry/fallback) and 4 (parse model list) from round 1 are fixed
in `5daa12f`. Item 2 (silence answered with the prompt example) is not: see round 2.

1. Round 1, `gemini-3.1-flash-lite` and `gpt-4.1-mini` returned the catalog price as `unit_price` and the
   backend labelled it `spoken` (45 of 47 and 44 of 46 unpriced lines, e.g. `02-single-lavie`). Fixed.
2. Silence and noise answered with the prompt example: `39-silence`, `40-noise-only`. Still open.
3. A single model list turned 429s into `voice_unavailable`. Retry and a second entry now absorb it when the
   chain has two entries; with one entry (`--model`, or the parse list in run D) it still fails.
4. The STT parse could not use a different model than the audio slugs. `VOICE_PARSE_MODELS` now exists.
