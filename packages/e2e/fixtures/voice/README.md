# Voice e2e clips

Short spoken clips for the voice sale flow. The audio files are recorded by the owner and are not
committed from automation; this README fixes the names and what each must contain. Format:
`audio/mp4` (m4a), at most 30 seconds and 1 MB, Vietnamese unless noted.

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

| Clip                  | Says                                | Expected result                                                       |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `two-line-sale.m4a`   | two cans of Coca and one Pepsi      | intent sale, two matched lines (2 and 1), cash                        |
| `unknown-product.m4a` | one bag of ST25 rice at 35 thousand | intent sale, one unknown line, spoken price 35000, manual on sale     |
| `credit-sale.m4a`     | two Coca on credit for chị Lan      | intent sale, one matched line, payment credit, customer match for Lan |
| `ambiguous.m4a`       | three cans of soft drink            | intent sale, one ambiguous line with 3 candidates                     |
| `no-speech.m4a`       | silence or background noise only    | 422 `no_speech`, no sidecar lines                                     |
| `chat-intent.m4a`     | how much did I sell today           | intent chat, no draft                                                 |

The mobile mock (`apps/mobile/src/test/mock/voice.ts`) selects its canned draft by these file
names, so the same names drive both the mock suite and the real-model e2e.
