# Voice eval 2026-10-29 · google/gemini-2.5-flash-lite · full

- Verdict: **FAIL**
- Run: `voice-2026-10-29-f5859e` · commit `b0d0b317e50e` · backend 127.0.0.1:18081
- Cases: 52 scored, 14 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 56.1 %               | ≥ 90 %   |
| Price accuracy                           | 57.6 %               | ≥ 97 %   |
| Quantity accuracy                        | 62.1 %               |          |
| Intent accuracy                          | 73.1 %               |          |
| Payment accuracy                         | 70.2 %               |          |
| Customer accuracy                        | 50 %                 |          |
| Cases exactly right                      | 61.5 %               |          |
| Extra lines (hallucinated)               | 1                    |          |
| WER (diacritics kept)                    | 29.4 %               |          |
| WER (diacritics stripped)                | 28.4 %               |          |
| Latency p50 / p95 (client)               | 3408 ms / 5748 ms    |          |
| Latency p50 / p95 (server)               | 3393 ms / 5733 ms    |          |
| Cost per utterance                       | $0.00025 (31 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 01-single-coca               | sale   | 0/1   | 0/1 | 0/1   |        | 4813      | error voice_unavailable |
| 02-single-lavie              | sale   | 0/1   | 0/1 | 0/1   |        | 5032      | error voice_unavailable |
| 03-single-hao-hao            | sale   | 0/1   | 0/1 | 0/1   |        | 4427      | error voice_unavailable |
| 04-single-tiger              | sale   | 0/1   | 0/1 | 0/1   |        | 3278      | error voice_unavailable |
| 05-single-trung              | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3327      | ok                      |
| 06-single-no-qty             | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 4906      | ok                      |
| 07-single-sua                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3097      | ok                      |
| 08-single-omo                | sale   | 1/1   | 1/1 | 1/1   | 40 %   | 5770      | ok                      |
| 09-multi-coca-pepsi          | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 4477      | ok                      |
| 10-multi-three               | sale   | 3/3   | 3/3 | 3/3   | 16.7 % | 5748      | ok                      |
| 11-multi-beers               | sale   | 2/2   | 2/2 | 2/2   | 72.7 % | 3767      | ok                      |
| 12-multi-four                | sale   | 0/4   | 0/4 | 0/4   |        | 4221      | error voice_unavailable |
| 13-multi-snacks              | sale   | 0/2   | 0/2 | 0/2   |        | 5566      | error voice_unavailable |
| 14-multi-milk-eggs           | sale   | 0/2   | 0/2 | 0/2   |        | 3531      | error voice_unavailable |
| 15-multi-drinks              | sale   | 0/3   | 0/3 | 0/3   |        | 3836      | error voice_unavailable |
| 16-multi-household           | sale   | 0/2   | 0/2 | 0/2   |        | 5048      | error voice_unavailable |
| 17-price-20k                 | sale   | 0/1   | 0/1 | 0/1   |        | 3530      | error voice_unavailable |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 4194      | ok                      |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3081      | ok                      |
| 20-price-muoi-ruoi           | sale   | 0/1   | 1/1 | 0/1   | 42.9 % | 3157      | lines                   |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2998      | ok                      |
| 22-price-hai-tram            | sale   | 0/1   | 1/1 | 0/1   | 44.4 % | 4855      | lines                   |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3080      | ok                      |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 57.1 % | 3210      | ok                      |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 62.5 % | 3408      | ok                      |
| 26-price-line-total-mismatch | sale   | 0/1   | 1/1 | 0/1   | 27.3 % | 5116      | 1 extra                 |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 4006      | ok                      |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 38.9 % | 4592      | ok                      |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3133      | ok                      |
| 30-credit-lan-coca           | sale   | 0/1   | 0/1 | 0/1   |        | 3816      | error voice_unavailable |
| 31-credit-hung               | sale   | 0/2   | 0/2 | 0/2   |        | 4115      | error voice_unavailable |
| 32-credit-mai                | sale   | 0/1   | 0/1 | 0/1   |        | 3722      | error voice_unavailable |
| 33-transfer-coca             | sale   | 0/1   | 0/1 | 0/1   |        | 3284      | error voice_unavailable |
| 34-transfer-multi            | sale   | 2/2   | 2/2 | 2/2   | 5.9 %  | 3881      | ok                      |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 9.1 %  | 3341      | ok                      |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 3195      | ok                      |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 3079      | ok                      |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 2944      | ok                      |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 1294      | ok                      |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 1948      | ok                      |
| 41-unknown-rau               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4725      | ok                      |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3462      | ok                      |
| 43-unknown-mixed             | sale   | 2/2   | 2/2 | 2/2   | 41.7 % | 3741      | ok                      |
| 44-ambiguous-hao-hao         | sale   | 0/1   | 0/1 | 1/1   | 20 %   | 2972      | lines                   |
| 45-ambiguous-bia             | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3822      | ok                      |
| 46-two-speakers-sale         | sale   | 1/2   | 1/2 | 1/2   | 170 %  | 4513      | lines                   |
| 47-two-speakers-credit       | sale   | 1/1   | 1/1 | 1/1   | 11.1 % | 3071      | ok                      |
| 48-two-speakers-sauce        | sale   | 2/2   | 2/2 | 2/2   | 18.8 % | 4083      | ok                      |
| 49-noise-two-line            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 3378      | ok                      |
| 50-noise-price               | sale   | 0/1   | 1/1 | 0/1   | 55.6 % | 3402      | lines                   |
| 51-noise-credit              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3306      | ok                      |
| 52-noise-single              | sale   | 1/1   | 1/1 | 1/1   | 12.5 % | 5661      | ok                      |
