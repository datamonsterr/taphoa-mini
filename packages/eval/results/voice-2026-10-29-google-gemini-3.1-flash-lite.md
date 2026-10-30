# Voice eval 2026-10-29 · google/gemini-3.1-flash-lite · full

- Verdict: **FAIL**
- Run: `voice-2026-10-29-b3759a` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 52 scored, 1 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 28.8 %               | ≥ 90 %   |
| Price accuracy                           | 28.8 %               | ≥ 97 %   |
| Quantity accuracy                        | 97 %                 |          |
| Intent accuracy                          | 94.2 %               |          |
| Payment accuracy                         | 97.9 %               |          |
| Customer accuracy                        | 100 %                |          |
| Cases exactly right                      | 38.5 %               |          |
| Extra lines (hallucinated)               | 7                    |          |
| WER (diacritics kept)                    | 11.5 %               |          |
| WER (diacritics stripped)                | 11.5 %               |          |
| Latency p50 / p95 (client)               | 2032 ms / 2851 ms    |          |
| Latency p50 / p95 (server)               | 2014 ms / 2440 ms    |          |
| Cost per utterance                       | $0.00127 (40 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 01-single-coca               | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3062      | lines                   |
| 02-single-lavie              | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3763      | lines                   |
| 03-single-hao-hao            | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 2453      | lines                   |
| 04-single-tiger              | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 2062      | lines                   |
| 05-single-trung              | sale   | 0/1   | 0/1 | 0/1   |        | 8012      | error voice_unavailable |
| 06-single-no-qty             | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 2498      | lines                   |
| 07-single-sua                | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 1971      | lines                   |
| 08-single-omo                | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 1751      | lines                   |
| 09-multi-coca-pepsi          | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 1971      | lines                   |
| 10-multi-three               | sale   | 0/3   | 3/3 | 0/3   | 0 %    | 2180      | lines                   |
| 11-multi-beers               | sale   | 0/2   | 2/2 | 0/2   | 27.3 % | 2066      | lines                   |
| 12-multi-four                | sale   | 0/4   | 4/4 | 0/4   | 0 %    | 2440      | lines                   |
| 13-multi-snacks              | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 2244      | lines                   |
| 14-multi-milk-eggs           | sale   | 0/2   | 2/2 | 0/2   | 16.7 % | 2100      | lines                   |
| 15-multi-drinks              | sale   | 0/3   | 3/3 | 0/3   | 33.3 % | 2043      | lines                   |
| 16-multi-household           | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 2134      | lines                   |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 2054      | ok                      |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 2032      | ok                      |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 1833      | ok                      |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 1954      | ok                      |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2527      | ok                      |
| 22-price-hai-tram            | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 2041      | ok                      |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 1998      | ok                      |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 42.9 % | 2403      | ok                      |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 50 %   | 2091      | ok                      |
| 26-price-line-total-mismatch | sale   | 1/1   | 1/1 | 1/1   | 27.3 % | 2024      | ok                      |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 2130      | ok                      |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 2276      | ok                      |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 1966      | ok                      |
| 30-credit-lan-coca           | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 2144      | lines                   |
| 31-credit-hung               | sale   | 0/2   | 2/2 | 0/2   | 14.3 % | 2007      | lines                   |
| 32-credit-mai                | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 1924      | lines                   |
| 33-transfer-coca             | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 1843      | lines                   |
| 34-transfer-multi            | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 2191      | lines                   |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1940      | ok                      |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1731      | ok                      |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1709      | ok                      |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1843      | ok                      |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 1895      | intent sale, 3 extra    |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 2387      | intent sale, 3 extra    |
| 41-unknown-rau               | sale   | 0/1   | 0/1 | 0/1   | 0 %    | 2016      | 1 extra                 |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1996      | ok                      |
| 43-unknown-mixed             | sale   | 1/2   | 2/2 | 1/2   | 25 %   | 2068      | lines                   |
| 44-ambiguous-hao-hao         | sale   | 0/1   | 1/1 | 0/1   | 20 %   | 1946      | lines                   |
| 45-ambiguous-bia             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1857      | ok                      |
| 46-two-speakers-sale         | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 2851      | lines                   |
| 47-two-speakers-credit       | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 1953      | lines                   |
| 48-two-speakers-sauce        | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 2294      | lines                   |
| 49-noise-two-line            | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 1996      | lines                   |
| 50-noise-price               | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 1965      | ok                      |
| 51-noise-credit              | sale   | 0/1   | 1/1 | 0/1   | 12.5 % | 1961      | lines                   |
| 52-noise-single              | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 2029      | lines                   |
