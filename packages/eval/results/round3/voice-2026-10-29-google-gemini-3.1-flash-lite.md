# Voice eval 2026-10-29 · google/gemini-3.1-flash-lite · full

- Verdict: **PASS**
- Run: `voice-2026-10-29-2fa663` · commit `30f7bffa8635` · backend 127.0.0.1:18081
- Cases: 52 scored, 1 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 98.5 %               | ≥ 90 %   |
| Price accuracy                           | 98.5 %               | ≥ 97 %   |
| Quantity accuracy                        | 98.5 %               |          |
| Intent accuracy                          | 98.1 %               |          |
| Payment accuracy                         | 97.9 %               |          |
| Customer accuracy                        | 100 %                |          |
| Cases exactly right                      | 98.1 %               |          |
| Extra lines (hallucinated)               | 0                    |          |
| WER (diacritics kept)                    | 10 %                 |          |
| WER (diacritics stripped)                | 10 %                 |          |
| Latency p50 / p95 (client)               | 2056 ms / 3014 ms    |          |
| Latency p50 / p95 (server)               | 2001 ms / 2738 ms    |          |
| Cost per utterance                       | $0.00133 (28 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result                  |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------------- |
| 01-single-coca               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 4099      | ok                      |
| 02-single-lavie              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2056      | ok                      |
| 03-single-hao-hao            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1707      | ok                      |
| 04-single-tiger              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1830      | ok                      |
| 05-single-trung              | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 1646      | ok                      |
| 06-single-no-qty             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2290      | ok                      |
| 07-single-sua                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1907      | ok                      |
| 08-single-omo                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1707      | ok                      |
| 09-multi-coca-pepsi          | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2136      | ok                      |
| 10-multi-three               | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 2676      | ok                      |
| 11-multi-beers               | sale   | 2/2   | 2/2 | 2/2   | 27.3 % | 2135      | ok                      |
| 12-multi-four                | sale   | 4/4   | 4/4 | 4/4   | 0 %    | 2388      | ok                      |
| 13-multi-snacks              | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 1958      | ok                      |
| 14-multi-milk-eggs           | sale   | 2/2   | 2/2 | 2/2   | 16.7 % | 2056      | ok                      |
| 15-multi-drinks              | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 2118      | ok                      |
| 16-multi-household           | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2146      | ok                      |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 2118      | ok                      |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3915      | ok                      |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3014      | ok                      |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 1640      | ok                      |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2082      | ok                      |
| 22-price-hai-tram            | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 2233      | ok                      |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 1996      | ok                      |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 42.9 % | 2294      | ok                      |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 37.5 % | 1772      | ok                      |
| 26-price-line-total-mismatch | sale   | 1/1   | 1/1 | 1/1   | 27.3 % | 1803      | ok                      |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 2745      | ok                      |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 2380      | ok                      |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1823      | ok                      |
| 30-credit-lan-coca           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2012      | ok                      |
| 31-credit-hung               | sale   | 2/2   | 2/2 | 2/2   | 14.3 % | 1906      | ok                      |
| 32-credit-mai                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1819      | ok                      |
| 33-transfer-coca             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1856      | ok                      |
| 34-transfer-multi            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2205      | ok                      |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1776      | ok                      |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1480      | ok                      |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1919      | ok                      |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1585      | ok                      |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 45        | ok                      |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 53        | ok                      |
| 41-unknown-rau               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1829      | ok                      |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1789      | ok                      |
| 43-unknown-mixed             | sale   | 2/2   | 2/2 | 2/2   | 25 %   | 2153      | ok                      |
| 44-ambiguous-hao-hao         | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2019      | ok                      |
| 45-ambiguous-bia             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2224      | ok                      |
| 46-two-speakers-sale         | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2083      | ok                      |
| 47-two-speakers-credit       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1991      | ok                      |
| 48-two-speakers-sauce        | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2239      | ok                      |
| 49-noise-two-line            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2242      | ok                      |
| 50-noise-price               | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 1954      | ok                      |
| 51-noise-credit              | sale   | 1/1   | 1/1 | 1/1   | 12.5 % | 2875      | ok                      |
| 52-noise-single              | sale   | 0/1   | 0/1 | 0/1   |        | 8011      | error voice_unavailable |
