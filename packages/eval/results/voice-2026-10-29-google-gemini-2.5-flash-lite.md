# Voice eval 2026-10-29 · google/gemini-2.5-flash-lite · full

- Verdict: **FAIL**
- Run: `voice-2026-10-29-6631e0` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 52 scored, 7 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 78.8 %               | ≥ 90 %   |
| Price accuracy                           | 80.3 %               | ≥ 97 %   |
| Quantity accuracy                        | 83.3 %               |          |
| Intent accuracy                          | 86.5 %               |          |
| Payment accuracy                         | 87.2 %               |          |
| Customer accuracy                        | 66.7 %               |          |
| Cases exactly right                      | 71.2 %               |          |
| Extra lines (hallucinated)               | 4                    |          |
| WER (diacritics kept)                    | 15 %                 |          |
| WER (diacritics stripped)                | 14.8 %               |          |
| Latency p50 / p95 (client)               | 3783 ms / 4388 ms    |          |
| Latency p50 / p95 (server)               | 3742 ms / 4289 ms    |          |
| Cost per utterance                       | $0.00027 (39 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 01-single-coca               | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 5370      | ok                      |
| 02-single-lavie              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3846      | ok                      |
| 03-single-hao-hao            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3783      | ok                      |
| 04-single-tiger              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3533      | ok                      |
| 05-single-trung              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3501      | ok                      |
| 06-single-no-qty             | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3571      | ok                      |
| 07-single-sua                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3744      | ok                      |
| 08-single-omo                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4226      | ok                      |
| 09-multi-coca-pepsi          | sale   | 2/2   | 2/2 | 2/2   | 71.4 % | 3891      | ok                      |
| 10-multi-three               | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 3236      | ok                      |
| 11-multi-beers               | sale   | 2/2   | 2/2 | 2/2   | 27.3 % | 3000      | ok                      |
| 12-multi-four                | sale   | 4/4   | 4/4 | 4/4   | 0 %    | 4273      | ok                      |
| 13-multi-snacks              | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 3885      | ok                      |
| 14-multi-milk-eggs           | sale   | 2/2   | 2/2 | 2/2   | 8.3 %  | 4388      | ok                      |
| 15-multi-drinks              | sale   | 2/3   | 2/3 | 3/3   | 0 %    | 4869      | lines                   |
| 16-multi-household           | sale   | 2/2   | 2/2 | 2/2   | 16.7 % | 3930      | ok                      |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4013      | ok                      |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4223      | ok                      |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3814      | ok                      |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 28.6 % | 3754      | ok                      |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2936      | ok                      |
| 22-price-hai-tram            | sale   | 0/1   | 1/1 | 0/1   | 55.6 % | 3463      | lines                   |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3814      | ok                      |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 28.6 % | 3842      | ok                      |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 37.5 % | 4245      | ok                      |
| 26-price-line-total-mismatch | sale   | 0/1   | 1/1 | 0/1   | 27.3 % | 3077      | 1 extra                 |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3346      | ok                      |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 3612      | ok                      |
| 29-credit-lan-nuoc-mam       | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3770      | lines                   |
| 30-credit-lan-coca           | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 3749      | ok                      |
| 31-credit-hung               | sale   | 2/2   | 2/2 | 2/2   | 14.3 % | 3912      | ok                      |
| 32-credit-mai                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3172      | payment, customer       |
| 33-transfer-coca             | sale   | 1/1   | 1/1 | 1/1   | 60 %   | 3877      | ok                      |
| 34-transfer-multi            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 4300      | ok                      |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 9.1 %  | 3916      | ok                      |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   |        | 2894      | error voice_unavailable |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   |        | 2673      | error voice_unavailable |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 4267      | ok                      |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 3393      | ok                      |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 7057      | ok                      |
| 41-unknown-rau               | sale   | 0/1   | 0/1 | 0/1   | 16.7 % | 3280      | 1 extra                 |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4117      | ok                      |
| 43-unknown-mixed             | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 3510      | ok                      |
| 44-ambiguous-hao-hao         | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3113      | ok                      |
| 45-ambiguous-bia             | sale   | 0/1   | 0/1 | 0/1   | 100 %  | 3672      | 1 extra                 |
| 46-two-speakers-sale         | sale   | 1/2   | 1/2 | 1/2   | 30 %   | 3424      | 1 extra                 |
| 47-two-speakers-credit       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3699      | ok                      |
| 48-two-speakers-sauce        | sale   | 0/2   | 0/2 | 0/2   |        | 3088      | error voice_unavailable |
| 49-noise-two-line            | sale   | 0/2   | 0/2 | 0/2   |        | 2877      | error voice_unavailable |
| 50-noise-price               | sale   | 0/1   | 0/1 | 0/1   |        | 3112      | error voice_unavailable |
| 51-noise-credit              | sale   | 0/1   | 0/1 | 0/1   |        | 2605      | error voice_unavailable |
| 52-noise-single              | sale   | 0/1   | 0/1 | 0/1   |        | 3268      | error voice_unavailable |
