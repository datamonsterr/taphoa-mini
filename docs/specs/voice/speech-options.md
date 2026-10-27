# Speech options for the voice program: comparison and decision

Status: Proposed · Date: 2026-10-27 · Program: [README](README.md) · ADR
[0008](../../adr/0008-voice-audio-native-model.md)

Prices were read on 2026-10-27 from the vendor pages linked in "Sources". Clip cost assumes a
30-second utterance, the program maximum. "Hops" counts network round trips from audio to a
parsed sale draft: an audio-native model needs one (audio in, JSON out); a speech-to-text
service needs two (transcript, then a text model to parse it).

## What the voice sale needs

- Vietnamese shop speech with product names, brand names, units (chai, lon, gói, thùng, kg)
  and price shorthand ("20k", "hai chục", "hai lăm", "mười rưỡi", "hai trăm").
- Numbers must come out right: the price is the point of the feature.
- Catalog context: the store's own product names bias recognition ("Hảo Hảo", "Sting đỏ").
- Latency under 3 seconds from release to draft, because the customer is waiting.
- Clips are short (median about 5 s, maximum 30 s), one speaker, phone microphone, shop noise.
- Cost that stays negligible next to the revenue of a sale (a few hundred đồng at most).

## Candidates

Audio seconds to tokens for Gemini: the audio guide says 32 tokens per second; the pricing
page says 25. Costs below use 32 (the conservative figure). Text prompt per call assumed:
3,000 tokens (system prompt, rules, JSON schema and a catalog hint of about 300 product
names); output 150 tokens.

| Option                                                               | Price (verified)                                                   | Vietnamese                                                        | Hops | Cost per 30 s clip                 | Notes                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | ---- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Gemini 2.5 Flash-Lite, audio-native, via OpenRouter**              | $0.10/M text in, $0.30/M audio in, $0.40/M out; cache read $0.01/M | Yes (Gemini Flash 2: 4.2 % WER on FLEURS, vendor-reported)        | 1    | **$0.0007**                        | Tools, `response_format` and `structured_outputs` supported; 1M context; same client and key as the assistant                       |
| Gemini 3.1 Flash-Lite, audio-native                                  | $0.25/M text, $0.50/M audio, $1.50/M out                           | Yes                                                               | 1    | $0.0015                            | Newer; upgrade path by slug                                                                                                         |
| Gemini 3.5 Flash-Lite, audio-native                                  | $0.30/M all inputs, $2.50/M out                                    | Yes                                                               | 1    | $0.0016                            | Newer; output price 6× 2.5 Flash-Lite                                                                                               |
| Gemini 2.5 Flash, audio-native                                       | $0.30/M text, $1.00/M audio, $2.50/M out                           | Yes                                                               | 1    | $0.0022                            | Stronger reasoning, not needed for a sale line                                                                                      |
| Gemini 3.5 Transcribe (dedicated STT)                                | $2.00/M audio in, $12/M out                                        | 85+ languages, Vietnamese not confirmed on the list we could read | 2    | $0.0024 + parse                    | Diarization and timestamps, not needed                                                                                              |
| Gemini 2.5 Flash Native Audio / 3.x Live                             | $3.00/M audio in, $12/M audio out                                  | Yes                                                               | 1    | $0.003+                            | Built for live conversation; overkill for clips                                                                                     |
| OpenRouter STT `openai/whisper-large-v3-turbo`                       | $3.33 per 1M audio seconds (= $0.012/h)                            | 99+ languages; Whisper large v3 10.7 % WER on FLEURS Vietnamese   | 2    | **$0.0001** + parse                | Cheapest; weaker Vietnamese; no catalog bias; `prompt` ignored on multipart                                                         |
| Groq `whisper-large-v3-turbo` (direct)                               | $0.04/h                                                            | same as above                                                     | 2    | $0.0003 + parse                    | Second key and client to maintain                                                                                                   |
| OpenRouter STT `qwen/qwen3-asr-0.6b` / NVIDIA Nemotron 3.5 ASR       | $3.33 per 1M audio seconds                                         | Qwen3-ASR lists 30 languages incl. Vietnamese                     | 2    | $0.0001 + parse                    | Candidates for the V5 bake-off only                                                                                                 |
| ElevenLabs Scribe v2 (batch)                                         | $0.22/h (+$0.05/h keyterm prompting); realtime $0.39/h             | 90+ languages; Scribe v1 3.5 % WER on FLEURS Vietnamese           | 2    | $0.0018 + parse                    | Best published Vietnamese WER; keyterm prompting gives catalog bias at extra cost; also on OpenRouter ($61.11 per 1M audio seconds) |
| Fish Audio `transcribe-1` / `transcribe-1-pro`                       | $0.36/h, rounded up to the second                                  | Language list not published for ASR                               | 2    | $0.003 + parse                     | TTS-first vendor; Vietnamese unverified                                                                                             |
| Vbee (Vietnamese vendor)                                             | No public price; batch, realtime and streaming STT APIs documented | Vietnamese specialist                                             | 2    | quote                              | Ask for a quote; bake off in V5 only if Gemini misses the bar                                                                       |
| OpenAI `gpt-4o-mini-transcribe` / `gpt-transcribe` / `whisper-1`     | $0.003/min / $0.0045/min / $0.006/min                              | Yes                                                               | 2    | $0.0015 / $0.0023 / $0.003 + parse | `whisper-1` reported as legacy by third parties; OpenAI's page still lists it                                                       |
| Deepgram Nova-3 (batch, monolingual)                                 | $0.0043/min                                                        | Yes (`vi` listed for Nova-3)                                      | 2    | $0.0022 + parse                    | Nova 2 11.6 % WER on FLEURS Vietnamese (ElevenLabs's table)                                                                         |
| Google Cloud Speech-to-Text Chirp 3                                  | $0.016/min                                                         | 24 GA + 77 preview languages                                      | 2    | $0.008 + parse                     | Most expensive                                                                                                                      |
| On-device (`expo-speech-recognition`: Android SpeechRecognizer, iOS) | $0                                                                 | Depends on the device's language pack; accuracy unknown           | 1*   | $0 (+ parse)                       | Already in the app; no catalog bias; partial results; the only offline option                                                       |
| Self-hosted Whisper / Qwen3-ASR on Railway                           | Railway CPU only                                                   | Yes                                                               | 2    | ops time                           | CPU inference of 30 s takes 5-10 s; rejected                                                                                        |

\* On-device recognition returns text, so the server still parses it (one text-only call,
about $0.0004 on 2.5 Flash-Lite).

"Parse" means one text-only call of `google/gemini-2.5-flash-lite` (3,000 prompt tokens,
150 output tokens): about $0.0004, so every two-hop option costs its STT price plus $0.0004
and adds one round trip (about 700 ms to 1.5 s).

The free OpenRouter text models the assistant uses today are not a parse option for a sale:
the X7 smoke run measured p95 latency of 30-37 s and weak number grounding (issue #58).

## Monthly cost at 100 utterances per store per day (3,000 per month)

| Option                                                  | Per store per month | 100 stores |
| ------------------------------------------------------- | ------------------- | ---------- |
| Gemini 2.5 Flash-Lite audio-native (one call)           | $2.0                | $200       |
| Whisper large v3 turbo on OpenRouter + Flash-Lite parse | $1.5                | $150       |
| ElevenLabs Scribe v2 + parse                            | $6.6                | $660       |
| Fish Audio + parse                                      | $10.2               | $1,020     |
| Deepgram Nova-3 + parse                                 | $7.8                | $780       |
| Chirp 3 + parse                                         | $25.2               | $2,520     |
| On-device + parse                                       | $1.2                | $120       |

Prompt caching on the fixed part of the prompt (system text, schema, catalog hint) brings the
Flash-Lite call to about $0.0004, since cache reads cost $0.01/M on OpenRouter for this model.

## Decision

**Default: one audio-native call to `google/gemini-2.5-flash-lite` through OpenRouter**
(`input_audio` plus a JSON schema), with `VOICE_MODELS` as an ordered fallback list
(`google/gemini-2.5-flash-lite`, `google/gemini-3.1-flash-lite`).

Why this one:

- **Dynamics.** One hop, no transcript round trip, p95 under 3 s is realistic (Flash-Lite is
  the latency-optimized tier). The model slug is configuration, so a newer Flash-Lite is a
  variable change plus a golden-set run.
- **Cost.** Second cheapest overall and cheapest among options that also parse; about $2 per
  active store per month at 100 utterances a day; negligible next to a sale.
- **Vietnamese.** Gemini's published Vietnamese WER (4.2 % on FLEURS, in a competitor's own
  table) is near the best; the catalog hint in the prompt biases product names and the model
  sees the whole utterance when it normalizes prices, which a plain transcript cannot do.
- **Fit.** Same OpenRouter client, key, telemetry (`$ai_generation` with cost) and quota code
  as the assistant; structured outputs and tools are supported if the parse later needs them.

Fallback chain, in order:

1. Next slug in `VOICE_MODELS`.
2. OpenRouter STT `openai/whisper-large-v3-turbo` (`VOICE_STT_MODEL`), then a text-only parse
   call to the first available `VOICE_MODELS` slug. Used on audio-input errors or when every
   audio-native slug is down.
3. On-device recognition (`expo-speech-recognition`) when the phone is offline or the server
   returns `503`; the text is parsed on the server when online again, or the seller types the
   sale into the cart.

Not chosen, and why:

- **ElevenLabs Scribe** has the best published Vietnamese WER but costs 2.5× and needs a
  second hop; it is the first bake-off candidate in V5 if product names miss the bar.
- **Fish Audio** is a text-to-speech vendor first; Vietnamese ASR is undocumented.
- **Vbee** publishes no API price; worth a quote only on evidence from the golden set.
- **Whisper (OpenAI API)** costs 4× the OpenRouter-hosted turbo variant for the same model
  family, with weaker Vietnamese than Gemini.
- **Chirp 3** is the most expensive per minute by far.
- **Gemini Live and native-audio models** are priced for live conversation ($3/M audio in).
- **Self-hosting** needs a GPU Railway does not offer.

## Sources

- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing (audio tokens: 25 per second
  on this page; the audio guide https://ai.google.dev/gemini-api/docs/audio says 32 per
  second, 20 MB inline limit, formats WAV, MP3, AIFF, AAC, OGG, FLAC, M4A, Opus, WebM)
- OpenRouter model catalog (prices per audio second for STT, per token for chat) read with the
  OpenRouter MCP on 2026-10-27; audio input guide
  https://openrouter.ai/docs/guides/overview/multimodal/audio and STT endpoint
  https://openrouter.ai/docs/guides/overview/multimodal/stt (25 MB multipart cap, 60 s
  upstream timeout, `usage.cost` per request)
- ElevenLabs API pricing https://elevenlabs.io/pricing/api; Vietnamese WER table
  https://elevenlabs.io/speech-to-text/vietnamese
- Fish Audio pricing https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
- OpenAI pricing https://developers.openai.com/api/docs/pricing
- Groq whisper-large-v3-turbo https://console.groq.com/docs/model/whisper-large-v3-turbo
- Deepgram languages https://developers.deepgram.com/docs/models-languages-overview
- Vbee API docs index https://api-docs.vbee.vn/llms.txt (STT batch, realtime, streaming pages;
  no price)
- Google Cloud Speech-to-Text pricing https://cloud.google.com/speech-to-text/pricing
