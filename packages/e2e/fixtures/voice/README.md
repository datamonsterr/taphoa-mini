# Voice e2e clips

Short spoken clips for the voice sale flow. The committed clips are synthetic (text to speech,
`"source": "synthetic"`), made by `packages/eval/scripts/voice-synth.ts` from the sidecars here:

```sh
cd packages/eval
node scripts/voice-synth.ts --dir ../e2e/fixtures/voice          # missing clips only
node scripts/voice-synth.ts --dir ../e2e/fixtures/voice --force  # all
```

Owner recordings replace them: drop a phone recording under the same name (`<name>.m4a`) and set
`"source": "recorded"` in the sidecar; the script then leaves that clip alone. This README fixes the
names and what each must contain. Format: `audio/mp4` (m4a), at most 30 seconds and 1 MB,
Vietnamese unless noted.

Every clip has a sidecar `<name>.json` next to it:

```json
{
  "transcript": "hai lon coca với một lon pepsi",
  "language": "vi",
  "intent": "sale",
  "payment_method": "cash",
  "lines": [
    { "spoken": "coca", "quantity": 2, "status": "matched" },
    { "spoken": "pepsi", "quantity": 1, "status": "matched" }
  ]
}
```

Fields: `transcript` (what a listener hears), `language`, `intent` (`sale`, `chat`, `none`),
`payment_method` (omit when no draft), `customer` (spoken name, credit only), and `lines`
(`spoken`, `quantity`, `status` of `matched`, `ambiguous` or `unknown`, optional `unit_price` for
a spoken price, optional `candidates` count).

Extra fields: `source` (`synthetic` or `recorded`), `requires_products` (names the e2e test creates
in the fresh store before posting the clip, since a new store has none; the sidecar names are plain
so the catalog match is stable), `requires_customers` (credit clips), `error` (`no_speech` clips
expect that 422), and synthesis hints `segments` (what the voice reads when it differs from the
written `transcript`, for example `ST25` read as letters) and `noise` (shop noise mixed in).

| Clip                  | Says                                | Expected result                                                       |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `two-line-sale.m4a`   | two cans of Coca and one Pepsi      | intent sale, two matched lines (2 and 1), cash                        |
| `unknown-product.m4a` | one bag of ST25 rice at 35 thousand | intent sale, one unknown line, spoken price 35000, manual on sale     |
| `credit-sale.m4a`     | two Coca on credit for chị Lan      | intent sale, one matched line, payment credit, customer match for Lan |
| `ambiguous.m4a`       | three cans of soft drink            | intent sale, one ambiguous line with 3 candidates                     |
| `no-speech.m4a`       | silence or background noise only    | 422 `no_speech`, no sidecar lines                                     |
| `chat-intent.m4a`     | how much did I sell today           | intent chat, no draft                                                 |
| `single-sale.m4a`     | one bottle of Chin-su chili sauce   | intent sale, one matched line (1), cash                               |
| `transfer-sale.m4a`   | two Coca, bank transfer             | intent sale, one matched line (2), payment transfer                   |
| `price-shorthand.m4a` | three Hảo Hảo noodles, "hai chục"   | intent sale, one matched line (3), spoken unit price 20000            |
| `noisy-sale.m4a`      | two Coca and one Pepsi, shop noise  | as `two-line-sale`, with background noise                             |

The mobile mock (`apps/mobile/src/test/mock/voice.ts`) selects its canned draft by these file
names, so the same names drive both the mock suite and the real-model e2e.
