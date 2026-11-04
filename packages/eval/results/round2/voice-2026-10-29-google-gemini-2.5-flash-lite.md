# Voice eval 2026-10-29 · google/gemini-2.5-flash-lite · full

- Verdict: **FAIL**
- Run: `voice-2026-10-29-3d9d24` · commit `b0d0b317e50e` · backend 127.0.0.1:18081
- Cases: 52 scored, 5 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 74.2 %               | ≥ 90 %   |
| Price accuracy                           | 74.2 %               | ≥ 97 %   |
| Quantity accuracy                        | 78.8 %               |          |
| Intent accuracy                          | 90.4 %               |          |
| Payment accuracy                         | 87.2 %               |          |
| Customer accuracy                        | 83.3 %               |          |
| Cases exactly right                      | 75 %                 |          |
| Extra lines (hallucinated)               | 6                    |          |
| WER (diacritics kept)                    | 13 %                 |          |
| WER (diacritics stripped)                | 13 %                 |          |
| Latency p50 / p95 (client)               | 3578 ms / 4979 ms    |          |
| Latency p50 / p95 (server)               | 3567 ms / 4854 ms    |          |
| Cost per utterance                       | $0.00028 (38 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 01-single-coca               | sale   | 0/1   | 0/1 | 0/1   | 33.3 % | 5879      | 2 extra                 |
| 02-single-lavie              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4138      | ok                      |
| 03-single-hao-hao            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3571      | ok                      |
| 04-single-tiger              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3162      | ok                      |
| 05-single-trung              | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3817      | ok                      |
| 06-single-no-qty             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3502      | ok                      |
| 07-single-sua                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3010      | ok                      |
| 08-single-omo                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2778      | ok                      |
| 09-multi-coca-pepsi          | sale   | 2/2   | 2/2 | 2/2   | 14.3 % | 4109      | ok                      |
| 10-multi-three               | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 4979      | ok                      |
| 11-multi-beers               | sale   | 0/2   | 0/2 | 0/2   |        | 5349      | error voice_unavailable |
| 12-multi-four                | sale   | 0/4   | 0/4 | 0/4   |        | 4790      | error voice_unavailable |
| 13-multi-snacks              | sale   | 2/2   | 2/2 | 2/2   | 30.8 % | 5356      | ok                      |
| 14-multi-milk-eggs           | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 3437      | ok                      |
| 15-multi-drinks              | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 4259      | ok                      |
| 16-multi-household           | sale   | 2/2   | 2/2 | 2/2   | 8.3 %  | 3289      | ok                      |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3782      | ok                      |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 12.5 % | 3578      | ok                      |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 2826      | ok                      |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 3115      | ok                      |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3752      | ok                      |
| 22-price-hai-tram            | sale   | 0/1   | 1/1 | 0/1   | 22.2 % | 3812      | lines                   |
| 23-price-bare                | sale   | 0/1   | 1/1 | 0/1   | 33.3 % | 3671      | lines                   |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 4043      | ok                      |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 37.5 % | 2991      | ok                      |
| 26-price-line-total-mismatch | sale   | 0/1   | 1/1 | 0/1   | 45.5 % | 3020      | 1 extra                 |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3601      | ok                      |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 3701      | ok                      |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4128      | ok                      |
| 30-credit-lan-coca           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3550      | ok                      |
| 31-credit-hung               | sale   | 2/2   | 2/2 | 2/2   | 14.3 % | 4038      | ok                      |
| 32-credit-mai                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3895      | payment, customer       |
| 33-transfer-coca             | sale   | 1/1   | 1/1 | 1/1   | 40 %   | 3177      | ok                      |
| 34-transfer-multi            | sale   | 2/2   | 2/2 | 2/2   | 5.9 %  | 2888      | ok                      |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3562      | ok                      |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 2803      | ok                      |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 14.3 % | 3175      | ok                      |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 3107      | ok                      |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 2613      | ok                      |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 3359      | ok                      |
| 41-unknown-rau               | sale   | 1/1   | 1/1 | 1/1   | 16.7 % | 3563      | ok                      |
| 42-unknown-banh-trang        | sale   | 0/1   | 0/1 | 0/1   |        | 8010      | error voice_unavailable |
| 43-unknown-mixed             | sale   | 0/2   | 0/2 | 0/2   |        | 5712      | error voice_unavailable |
| 44-ambiguous-hao-hao         | sale   | 0/1   | 0/1 | 0/1   |        | 5470      | error voice_unavailable |
| 45-ambiguous-bia             | sale   | 0/1   | 0/1 | 0/1   | 66.7 % | 4865      | 1 extra                 |
| 46-two-speakers-sale         | sale   | 1/2   | 1/2 | 1/2   | 20 %   | 4007      | 1 extra                 |
| 47-two-speakers-credit       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3155      | ok                      |
| 48-two-speakers-sauce        | sale   | 1/2   | 1/2 | 1/2   | 37.5 % | 3809      | 1 extra                 |
| 49-noise-two-line            | sale   | 2/2   | 2/2 | 2/2   | 14.3 % | 3919      | ok                      |
| 50-noise-price               | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 3645      | ok                      |
| 51-noise-credit              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3197      | ok                      |
| 52-noise-single              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3264      | ok                      |
