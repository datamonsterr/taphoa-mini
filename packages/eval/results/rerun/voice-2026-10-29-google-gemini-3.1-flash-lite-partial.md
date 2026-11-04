# Voice eval 2026-10-29 · google/gemini-3.1-flash-lite · partial

- Verdict: **FAIL**
- Run: `voice-2026-10-29-e54972` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 1 scored, 0 with errors, 0 not run

| Metric                                   | Value             | Bar      |
| ---------------------------------------- | ----------------- | -------- |
| Line accuracy (product, quantity, price) | 0 %               | ≥ 90 %   |
| Price accuracy                           | 0 %               | ≥ 97 %   |
| Quantity accuracy                        | 100 %             |          |
| Intent accuracy                          | 100 %             |          |
| Payment accuracy                         | 100 %             |          |
| Customer accuracy                        | n/a               |          |
| Cases exactly right                      | 0 %               |          |
| Extra lines (hallucinated)               | 0                 |          |
| WER (diacritics kept)                    | 25 %              |          |
| WER (diacritics stripped)                | 25 %              |          |
| Latency p50 / p95 (client)               | 2987 ms / 2987 ms |          |
| Latency p50 / p95 (server)               | 1942 ms / 1942 ms |          |
| Cost per utterance                       | n/a (0 priced)    | ≤ $0.002 |

## Cases

| Case            | Intent | Lines | Qty | Price | WER  | Client ms | Result |
| --------------- | ------ | ----- | --- | ----- | ---- | --------- | ------ |
| 05-single-trung | sale   | 0/1   | 1/1 | 0/1   | 25 % | 2987      | lines  |
