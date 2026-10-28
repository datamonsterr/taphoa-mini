# Voice eval 2026-10-29 · google/gemini-2.5-flash-lite · partial

- Verdict: **FAIL**
- Run: `voice-2026-10-29-d7b46f` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 2 scored, 0 with errors, 0 not run

| Metric                                   | Value             | Bar      |
| ---------------------------------------- | ----------------- | -------- |
| Line accuracy (product, quantity, price) | 66.7 %            | ≥ 90 %   |
| Price accuracy                           | 66.7 %            | ≥ 97 %   |
| Quantity accuracy                        | 100 %             |          |
| Intent accuracy                          | 100 %             |          |
| Payment accuracy                         | 100 %             |          |
| Customer accuracy                        | n/a               |          |
| Cases exactly right                      | 50 %              |          |
| Extra lines (hallucinated)               | 0                 |          |
| WER (diacritics kept)                    | 37.5 %            |          |
| WER (diacritics stripped)                | 37.5 %            |          |
| Latency p50 / p95 (client)               | 3795 ms / 5101 ms |          |
| Latency p50 / p95 (server)               | 3779 ms / 3866 ms |          |
| Cost per utterance                       | n/a (0 priced)    | ≤ $0.002 |

## Cases

| Case              | Intent | Lines | Qty | Price | WER    | Client ms | Result |
| ----------------- | ------ | ----- | --- | ----- | ------ | --------- | ------ |
| 49-noise-two-line | sale   | 2/2   | 2/2 | 2/2   | 42.9 % | 5101      | ok     |
| 50-noise-price    | sale   | 0/1   | 1/1 | 0/1   | 33.3 % | 3795      | lines  |
