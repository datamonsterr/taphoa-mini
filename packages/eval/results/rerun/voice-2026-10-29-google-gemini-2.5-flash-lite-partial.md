# Voice eval 2026-10-29 · google/gemini-2.5-flash-lite · partial

- Verdict: **FAIL**
- Run: `voice-2026-10-29-022867` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 7 scored, 2 with errors, 0 not run

| Metric                                   | Value               | Bar      |
| ---------------------------------------- | ------------------- | -------- |
| Line accuracy (product, quantity, price) | 57.1 %              | ≥ 90 %   |
| Price accuracy                           | 57.1 %              | ≥ 97 %   |
| Quantity accuracy                        | 57.1 %              |          |
| Intent accuracy                          | 71.4 %              |          |
| Payment accuracy                         | 60 %                |          |
| Customer accuracy                        | 100 %               |          |
| Cases exactly right                      | 71.4 %              |          |
| Extra lines (hallucinated)               | 0                   |          |
| WER (diacritics kept)                    | 6.7 %               |          |
| WER (diacritics stripped)                | 6.7 %               |          |
| Latency p50 / p95 (client)               | 4128 ms / 6460 ms   |          |
| Latency p50 / p95 (server)               | 3716 ms / 6449 ms   |          |
| Cost per utterance                       | $0.00041 (1 priced) | ≤ $0.002 |

## Cases

| Case                  | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| --------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 36-chat-sold-today    | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 4128      | ok                      |
| 37-chat-stock         | chat   | 0/0   | 0/0 | 0/0   | 14.3 % | 3733      | ok                      |
| 48-two-speakers-sauce | sale   | 2/2   | 2/2 | 2/2   | 12.5 % | 4374      | ok                      |
| 49-noise-two-line     | sale   | 0/2   | 0/2 | 0/2   |        | 2644      | error voice_unavailable |
| 50-noise-price        | sale   | 0/1   | 0/1 | 0/1   |        | 2736      | error voice_unavailable |
| 51-noise-credit       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 6460      | ok                      |
| 52-noise-single       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3221      | ok                      |
