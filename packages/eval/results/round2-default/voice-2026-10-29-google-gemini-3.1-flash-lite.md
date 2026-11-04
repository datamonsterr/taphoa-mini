# Voice eval 2026-10-29 · google/gemini-3.1-flash-lite · full

- Verdict: **PASS**
- Run: `voice-2026-10-29-494b11` · commit `b0d0b317e50e` · backend 127.0.0.1:18081
- Cases: 52 scored, 0 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 100 %                | ≥ 90 %   |
| Price accuracy                           | 100 %                | ≥ 97 %   |
| Quantity accuracy                        | 100 %                |          |
| Intent accuracy                          | 96.2 %               |          |
| Payment accuracy                         | 100 %                |          |
| Customer accuracy                        | 100 %                |          |
| Cases exactly right                      | 96.2 %               |          |
| Extra lines (hallucinated)               | 6                    |          |
| WER (diacritics kept)                    | 9.6 %                |          |
| WER (diacritics stripped)                | 9.6 %                |          |
| Latency p50 / p95 (client)               | 1915 ms / 2794 ms    |          |
| Latency p50 / p95 (server)               | 1882 ms / 2298 ms    |          |
| Cost per utterance                       | $0.00077 (40 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result               |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | -------------------- |
| 01-single-coca               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3153      | ok                   |
| 02-single-lavie              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1628      | ok                   |
| 03-single-hao-hao            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1731      | ok                   |
| 04-single-tiger              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1755      | ok                   |
| 05-single-trung              | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 1950      | ok                   |
| 06-single-no-qty             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1940      | ok                   |
| 07-single-sua                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1692      | ok                   |
| 08-single-omo                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1685      | ok                   |
| 09-multi-coca-pepsi          | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 1890      | ok                   |
| 10-multi-three               | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 2168      | ok                   |
| 11-multi-beers               | sale   | 2/2   | 2/2 | 2/2   | 27.3 % | 2085      | ok                   |
| 12-multi-four                | sale   | 4/4   | 4/4 | 4/4   | 0 %    | 2306      | ok                   |
| 13-multi-snacks              | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2009      | ok                   |
| 14-multi-milk-eggs           | sale   | 2/2   | 2/2 | 2/2   | 25 %   | 1958      | ok                   |
| 15-multi-drinks              | sale   | 3/3   | 3/3 | 3/3   | 0 %    | 1948      | ok                   |
| 16-multi-household           | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2171      | ok                   |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 1959      | ok                   |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3555      | ok                   |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 1710      | ok                   |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 14.3 % | 1338      | ok                   |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1917      | ok                   |
| 22-price-hai-tram            | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 1915      | ok                   |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 1808      | ok                   |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 42.9 % | 1708      | ok                   |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 37.5 % | 1759      | ok                   |
| 26-price-line-total-mismatch | sale   | 1/1   | 1/1 | 1/1   | 27.3 % | 1719      | ok                   |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 2794      | ok                   |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 33.3 % | 1996      | ok                   |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1920      | ok                   |
| 30-credit-lan-coca           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1647      | ok                   |
| 31-credit-hung               | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 1996      | ok                   |
| 32-credit-mai                | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1871      | ok                   |
| 33-transfer-coca             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1620      | ok                   |
| 34-transfer-multi            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 1893      | ok                   |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1994      | ok                   |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1699      | ok                   |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1602      | ok                   |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 1751      | ok                   |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 2201      | intent sale, 3 extra |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 2190      | intent sale, 3 extra |
| 41-unknown-rau               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2056      | ok                   |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1865      | ok                   |
| 43-unknown-mixed             | sale   | 2/2   | 2/2 | 2/2   | 25 %   | 2741      | ok                   |
| 44-ambiguous-hao-hao         | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1663      | ok                   |
| 45-ambiguous-bia             | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1702      | ok                   |
| 46-two-speakers-sale         | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2021      | ok                   |
| 47-two-speakers-credit       | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 1753      | ok                   |
| 48-two-speakers-sauce        | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 1981      | ok                   |
| 49-noise-two-line            | sale   | 2/2   | 2/2 | 2/2   | 0 %    | 2107      | ok                   |
| 50-noise-price               | sale   | 1/1   | 1/1 | 1/1   | 22.2 % | 1644      | ok                   |
| 51-noise-credit              | sale   | 1/1   | 1/1 | 1/1   | 12.5 % | 1666      | ok                   |
| 52-noise-single              | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 2174      | ok                   |
