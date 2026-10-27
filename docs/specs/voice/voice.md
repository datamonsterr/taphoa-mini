# Voice sale and voice chat: use cases, architecture, API and UI

Status: Proposed · Date: 2026-10-27 · Program: [README](README.md) · ADR
[0008](../../adr/0008-voice-audio-native-model.md) · Options: [speech-options.md](speech-options.md)

## Use cases

| ID   | Use case                     | What the seller does and gets                                                                                                                                                                   | Who |
| ---- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| V-U1 | Quick sale from anywhere     | Taps the voice bubble (Android), the Control Center control, the Action Button or says "Hey Siri, bán hàng Tạp Hóa" (iOS); says the sale; sees the draft; taps the check. Previous app returns. | all |
| V-U2 | Quick sale inside the app    | Long-presses the chat button on any shop screen or the camera; same sheet. A `voice_sale` next-step chip shows for 14 days after sign-in.                                                       | all |
| V-U3 | Credit sale by voice         | "Ghi nợ chị Lan hai chai nước mắm sáu chục": lines plus `payment_method=credit` and a customer match (Debt book U23 rules: unknown customer asks to pick or create one).                        | all |
| V-U4 | Transfer payment by voice    | "... chuyển khoản": the sheet's payment toggle is on transfer and Confirm opens the VietQR pay screen with the draft in the cart.                                                               | all |
| V-U5 | Fix the draft                | Tap a line to choose among candidates, use the stepper, delete a line, tap the price to retype it on the keypad, or hold the microphone again to add lines ("thêm một lon Coca").               | all |
| V-U6 | Chat by voice (upgrades U15) | Holds the microphone in the assistant composer; the server transcript fills the input; nothing is sent by itself; on-device recognition when offline.                                           | all |

Out of scope for this program: wake words and always-listening; spoken replies (TTS); stock
receipts, expenses, price changes or stock adjustments by voice (the assistant chat already
proposes those from text or dictation); the web app; an `AccessibilityService`.

## Architecture

```
Entry point ──► app route /voice?entry=… (foreground, translucent modal)
                  │  expo-audio: AAC m4a 16 kHz mono 32 kbps, ≤ 30 s, silence stop
                  ▼
   POST /v1/voice/utterances (multipart: audio, mode=sale, language, context)
                  │
   backend voice service
     ├─ quota check (per store per day) and size/duration check
     ├─ catalog hint: top 300 products by recent sales (name, unit, price) from a 5-min cache
     ├─ model call 1: OpenRouter chat completions, input_audio + JSON schema  (VOICE_MODELS[0])
     │     └─ on failure: next slug → STT (/audio/transcriptions, VOICE_STT_MODEL) + text parse
     ├─ catalog match per line (normalized name, aliases, trigram) → matched / ambiguous / unknown
     ├─ price and quantity rules; customer match for credit
     ├─ store voice_utterances row (transcript, parsed, draft, model, latency); drop the audio
     └─ telemetry: span voice.utterance, $ai_generation with cost
                  │
                  ▼
   VoiceUtterance { transcript, sale_draft }  ──► voice sale sheet ──► Confirm
                  │
   cart store → outbox → POST /v1/sales (lines source=voice|manual) → stock movement
                  │
   POST /v1/voice/utterances/{id}/outcome (confirmed | edited | abandoned, corrections)
                  └─ learns voice aliases from corrections; feeds the golden set
```

Latency budget (p95, Railway `test`, 4G): stop-to-upload 300 ms (about 120 KB), model call
1,500 ms, match and rules 100 ms, render 100 ms; total under 3 s. Hold-to-talk starts the
upload the moment the finger lifts; the sheet shows "Đang nghe..." then "Đang hiểu...".

## Speech model request

One chat completion with:

- `model`: first slug of `VOICE_MODELS`; `provider` preferences as the assistant client.
- System prompt (Vietnamese): the seller is logging a sale in a tạp hóa; return only the JSON;
  transcribe exactly; parse quantities, units and prices with the rules below; never invent a
  product that was not spoken; mark uncertainty in `confidence`.
- User content: `[{"type":"text","text":"<catalog hint JSON>"}, {"type":"input_audio",
"input_audio":{"data":"<base64>","format":"m4a"}}]`. The hint is data, never instructions
  (same injection rule as assistant tool output).
- `response_format`: JSON schema `VoiceParse` (strict):

```json
{
  "transcript": "một chai tương ớt hai mươi nghìn với hai gói hảo hảo",
  "language": "vi",
  "intent": "sale",
  "lines": [
    {
      "spoken": "chai tương ớt",
      "query": "tương ớt",
      "quantity": 1,
      "unit": "chai",
      "unit_price": 20000,
      "price_spoken": "hai mươi nghìn"
    },
    {
      "spoken": "hai gói hảo hảo",
      "query": "hảo hảo",
      "quantity": 2,
      "unit": "gói",
      "unit_price": null,
      "price_spoken": null
    }
  ],
  "payment_method": "cash",
  "customer_name": null,
  "confidence": 0.86
}
```

`intent` is `sale`, `chat` (the words are a question or request, for example "hôm nay bán
được bao nhiêu"), or `none` (nothing useful heard). In `mode=sale`, intent `chat` returns the
transcript with an empty draft and the sheet offers "Hỏi trợ lý" which opens the assistant
with the transcript as the prefilled request.

### Price and quantity rules (parsed by the model, re-checked by the backend)

| Spoken                                                   | Value                                                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "hai mươi nghìn", "20 nghìn", "20k"                      | 20,000                                                                                                                                                                  |
| "hai chục"                                               | 20,000                                                                                                                                                                  |
| "hai lăm", "hai mươi lăm"                                | 25,000                                                                                                                                                                  |
| "mười rưỡi"                                              | 10,500                                                                                                                                                                  |
| "trăm rưỡi", "một trăm rưỡi"                             | 150,000                                                                                                                                                                 |
| "hai trăm"                                               | 200,000 (shop shorthand), 200 is never a price                                                                                                                          |
| bare number under 1,000 ("hai mươi")                     | thousands (20,000) unless the catalog price of the matched product equals the bare value                                                                                |
| "ba cái năm nghìn"                                       | quantity 3, unit price 5,000 (per item)                                                                                                                                 |
| "ba cái mười lăm nghìn" where the catalog price is 5,000 | quantity 3, line total 15,000 → unit price 5,000; otherwise unit price 15,000 and the line shows a price-mismatch chip                                                  |
| no number before a product                               | quantity 1                                                                                                                                                              |
| "nửa ký", "hai lạng"                                     | 0.5 kg, 0.2 kg: quantities are integers in `SaleLineInput`, so weight units map to the product's base unit (`unit_id`) or the line becomes manual with the spoken label |

The backend validates ranges (quantity 1..999, price 500..50,000,000) and marks a line
`needs_price` when the price is missing and the product has no catalog price.

### Catalog match

- Normalize both sides like `assistant/tools/catalog.rs` (`immutable_unaccent`, lower, strip
  punctuation) and compare with trigram similarity plus token overlap; brand and size tokens
  ("330ml", "đỏ") count extra.
- Voice aliases: `voice_aliases(store_id, phrase, product_id, hits)` learned from outcomes
  (a correction twice for the same phrase, or one confirm of an ambiguous pick). Checked first.
- Bands: score at least 0.80 → `matched`; 0.50-0.80 → `ambiguous` with up to three
  candidates (top one preselected, amber chip); under 0.50 → `unknown` → manual line with
  `manual_label` = spoken words and the spoken price.
- Unit: the spoken unit picks the product's unit (`unit_id`) when it exists ("thùng" versus
  "lon"); otherwise the base unit.

## API contract (V0 edits `docs/api/openapi.yaml`)

### `POST /v1/voice/utterances`

Multipart form: `audio` (file; `audio/mp4` (m4a), `audio/wav` or `audio/ogg`; at most
`VOICE_MAX_BYTES` = 1 MB and `VOICE_MAX_SECONDS` = 30), `mode` (`sale` | `transcribe`),
`language` (`vi` | `en`, default `vi`), `context` (JSON: `entry`, `screen`, `thread_id?`).
Headers: `X-Store-Id`, Clerk session. All members; credit requires `RecordDebt` as for sales.

Response `201 VoiceUtterance`:

```yaml
VoiceUtterance:
  required:
    [id, mode, transcript, language, intent, model, latency_ms, created_at]
  properties:
    id: uuid
    mode: { enum: [sale, transcribe] }
    transcript: string
    language: { enum: [vi, en] }
    intent: { enum: [sale, chat, none] }
    confidence: { type: number, minimum: 0, maximum: 1 }
    sale_draft: { $ref: VoiceSaleDraft } # only mode=sale and intent=sale
    model: string # slug that answered
    stt_fallback: boolean # true when the STT path was used
    latency_ms: integer
    created_at: date-time
VoiceSaleDraft:
  required: [lines, payment_method, total]
  properties:
    lines:
      {
        type: array,
        items: { $ref: VoiceDraftLine },
        minItems: 1,
        maxItems: 50,
      }
    payment_method: { $ref: PaymentMethod } # cash | transfer | credit
    customer: { $ref: CustomerMatch } # for credit: matched | candidates | none
    total: { $ref: Money }
VoiceDraftLine:
  required: [id, spoken, quantity, status]
  properties:
    id: uuid # client reuses it as SaleLineInput.id
    spoken: string
    status: { enum: [matched, ambiguous, unknown] }
    product: { $ref: ProductSummary } # when matched or the preselected candidate
    candidates: { type: array, items: { $ref: ProductSummary }, maxItems: 3 }
    unit_id: uuid | null
    quantity: { type: integer, minimum: 1, maximum: 999 }
    unit_price: Money | null # spoken price, else catalog price, else null
    price_source: { enum: [spoken, catalog, none] }
    price_mismatch: boolean # spoken price differs from catalog
    needs_price: boolean
```

Errors: `400 audio_too_long` / `unsupported_format`, `413`, `422 no_speech` (nothing heard; the
app shows "Chưa nghe rõ, nói lại nhé"), `429 voice_quota` (per-store daily cap), `503
voice_unavailable` (every model failed; the app falls back to on-device recognition).

### `POST /v1/voice/utterances/{utteranceId}/outcome`

Body: `outcome` (`confirmed` | `edited` | `abandoned`), `sale_id?`, `corrections[]`
(`line_id`, `chosen_product_id?`, `quantity?`, `unit_price?`, `removed?`), `stage?` (`listening`,
`draft`, `pay`) for abandoned. Idempotent per utterance (last write wins). `204`.

### Sale contract change

`LineSource` gains `voice`. `sale_completed` gains `voice_lines`. `CreateSaleRequest` is
otherwise unchanged: the app builds `SaleLineInput` rows from the draft
(`product_id`, `unit_id`, `quantity`, `unit_price`, `source=voice`; manual lines keep
`source=manual` with `manual_label`).

### Telemetry

Spans: `voice.utterance` (`voice.mode`, `voice.entry`, `voice.audio_seconds`, `voice.model`,
`voice.stt_fallback`, `voice.intent`, `voice.lines`, `voice.matched`, `voice.ambiguous`,
`voice.unknown`, `voice.latency_ms`), child `voice.model_call` as a GenAI span and one
`$ai_generation` per model call with `$ai_input_tokens`, `$ai_output_tokens`, cost from
`usage.cost`, `$ai_session_id` = utterance id. No transcript in span attributes (it may
contain a customer name); the transcript lives only in `voice_utterances`.

Product events (app unless noted): `voice_setup_completed` (`platform`, `kind`: bubble, tile,
control, action_button, siri), `voice_sale_started` (`entry`), `voice_sale_drafted` (backend:
`lines`, `matched`, `ambiguous`, `unknown`, `latency_ms`, `stt_fallback`),
`voice_sale_confirmed` (`edited`, `line_count`, `payment_method`, `total`),
`voice_sale_abandoned` (`stage`), `voice_input_used` gains `engine` (`device`, `server`).

## Mobile UI

Screens 14-16 in [DESIGN.md](../../design/DESIGN.md).

- **Route `/voice`** (`src/app/voice.tsx` → `features/voice/VoiceSaleScreen`): transparent
  modal that slides from the bottom, like the assistant; params `entry` (`bubble`, `tile`,
  `control`, `action_button`, `siri`, `longpress`, `chip`), `returnToPrevious` (Android bubble
  sets it; Confirm or Close then call the native `moveTaskToBack`).
- **Listening state.** Dark sheet, large pulsing microphone (88 dp, camera-ring colour),
  level bars from metering, a 30 s countdown ring, hint "Nói tên hàng và giá", a big stop
  button. From the bubble it is tap-to-stop (phone may be on the counter); inside the app it is
  hold-to-talk like the chat. Auto-stop after 2 s of silence once something was heard.
- **Understanding state.** Transcript in large text, greyed, with a progress line; cancel.
- **Draft state.** Transcript on top (tap to see it in full). Lines like the cart: thumbnail,
  name, stepper, price, line total. Chips on the thumbnail: green check (matched), amber "?"
  (ambiguous: tap opens a three-candidate strip like the camera alternatives strip), grey tag
  (unknown: manual line at the spoken price; tap to search the catalog). Price in red with a
  pill when `price_mismatch`. Footer: total, payment toggle (tiền mặt / chuyển khoản / ghi nợ),
  microphone to add more lines, green check. Credit shows the customer row (matched name or
  "Chọn khách").
- **Confirm.** Cash: records the sale, haptic, toast "Đã bán 2 món · 24.500đ", closes.
  Transfer: pushes the draft into the cart and opens `/pay`. Credit: records with the
  customer (same rules as the pay sheet credit option).
- **Errors.** `no_speech`: "Chưa nghe rõ, nói lại nhé" with a retry microphone. Offline: the
  microphone records with on-device recognition, the transcript shows, and the sheet offers
  "Thêm vào giỏ" (open the cart with search prefilled) because the server parse is not
  available; the utterance is queued for parse when online only when the seller leaves it
  open. Quota: "Hết lượt nói hôm nay" with the cart as the way out. `503`: same as offline.
- **Chat microphone (V-U6).** `VoiceButton` keeps its hold-to-talk shape. Server mode: hold
  records with `expo-audio`, release uploads with `mode=transcribe`, the composer shows a
  three-dot placeholder until the transcript fills it. Partial live text exists only in the
  on-device fallback. Flag `voice_server_chat` (PostHog, default on) switches modes.
- **Account screen** gains a "Nút nói nhanh" section (Android: switch "Hiện nút nói trên màn
  hình" + "Thêm ô cài đặt nhanh"; iOS: instructions card with "Thêm vào Trung tâm điều
  khiển" and Action Button steps) and the "Góp giọng nói để cải thiện" opt-in switch.
- **i18n**: `vi` and `en` for every string. Accessibility: 56 dp targets, labels, text scales;
  screen-reader taps toggle listening as in `VoiceButton` today.

## Entry points

| Platform | Entry point                    | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Setup                                                                                                                                                 |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | Voice bubble over any app      | Expo Module (Kotlin): foreground service `specialUse` (subtype "floating voice shortcut") + `WindowManager` `TYPE_APPLICATION_OVERLAY` 56 dp bubble, draggable, snaps to an edge; tap starts `MainActivity` with `taphoa://voice?entry=bubble` and `FLAG_ACTIVITY_NEW_TASK` (allowed from the background because the app holds `SYSTEM_ALERT_WINDOW` and has a visible overlay, Android 15 rule); long-press hides it until the next app open. Persistent low-priority notification "Nút nói đang bật" with "Tắt". | Switch in Tài khoản explains, then opens Settings "Hiện trên ứng dụng khác"; on return the service starts. Restarts on boot only if the switch is on. |
| Android  | Quick Settings tile "Bán hàng" | `TileService`; `requestAddTileService()` on Android 13+ from the Account screen; `onClick` → `startActivityAndCollapse` with the deep link.                                                                                                                                                                                                                                                                                                                                                                        | "Thêm ô cài đặt nhanh" button                                                                                                                         |
| Android  | App shortcut                   | Static shortcut "Bán hàng bằng giọng nói" (long-press the icon).                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none                                                                                                                                                  |
| iOS      | Control Center control         | Apple target (`expo-apple-targets`, widget with `ControlWidget` button) whose App Intent opens `taphoa://voice?entry=control`; iOS 18+.                                                                                                                                                                                                                                                                                                                                                                            | Card with steps in Tài khoản                                                                                                                          |
| iOS      | Action Button                  | Assign the control (iPhone 15 Pro and later).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Card                                                                                                                                                  |
| iOS      | Siri / Shortcuts               | App Intent "Bán hàng bằng giọng nói" with a suggested phrase.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none                                                                                                                                                  |
| Both     | Long-press the chat button     | `ChatButton` `onLongPress` → `/voice?entry=longpress`; haptic.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                                                                                                                                                  |
| Both     | Next-step chip `voice_sale`    | Rule: first 14 days after joining and fewer than 3 voice sales; opens `/voice?entry=chip`.                                                                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                                                                                  |

Why not an `AccessibilityService`: see ADR 0008. The overlay permission is a standard,
user-granted permission with a Settings screen the app can open directly; the setup is the
same two-step shape the owner described (explain, enable in Settings), minus the policy risk.

## Privacy and policy

- Microphone permission texts in `app.json` already say "để bạn nói chuyện với trợ lý"; V2
  updates them to cover sales. `RECORD_AUDIO` is requested on the first voice use.
- Audio bytes live only in memory on the server during the model call. OpenRouter is told
  not to retain (`zdr` preference where the provider offers it, otherwise documented).
- `voice_utterances` keeps transcript, parsed JSON, draft, outcome and corrections for 30 days
  (retention job), longer for clips donated with the opt-in, which also stores the audio in
  the private bucket under `voice/<store>/<uuid>.m4a`.
- Play Console: data-safety entry "Audio: voice recordings, processed, not stored"; foreground
  service `specialUse` declaration text; "Hiện trên ứng dụng khác" rationale in the in-app
  explainer (prominent, before the Settings jump).
- The bubble never records by itself; only the foreground route does, and the system
  microphone indicator shows during recording.

## Tests

- Rust: parse re-check rules (table above as unit tests), catalog match bands, alias learning,
  quota, size and duration limits, model fallback chain with the scripted model client
  (audio-native ok, audio-native fails → STT → parse, all fail → 503), outcome idempotency,
  retention job, telemetry attributes with the in-memory exporter, contract tests.
- Mobile Jest: recorder hook (permission, 30 s cap, silence stop, cancel), sheet states,
  candidate pick, price retype, payment toggle, credit customer, cart hand-off, outcome
  posting, chat server mode and fallback, Account setup rows, entry-point param handling.
- E2E `packages/e2e/tests/voice.test.ts` against Railway `test` with fixture clips: a two-line
  sale, an unknown product, a credit sale, `no_speech`, quota; latency gate p95 under 3 s.
- Maestro Android (real device in CI is not available: run on the owner's phone): enable the
  bubble, background the app, tap the bubble, speak a fixture through the device speaker is
  not reliable, so the flow injects the fixture through a debug route and checks the sheet and
  the sale.
- Voice golden set (V5): at least 40 clips, scorers for transcript WER, line accuracy, price
  accuracy, latency and cost per model.
