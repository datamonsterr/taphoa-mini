# Voice eval 2026-10-29 · whisper-large-v3-turbo + openai/gpt-4.1-mini · full

- Verdict: **FAIL**
- Run: `voice-2026-10-29-503de4+reruns` · commit `7ee8d7ca264a` · backend 127.0.0.1:18081
- Cases: 52 scored, 0 with errors, 0 not run

| Metric                                   | Value                | Bar      |
| ---------------------------------------- | -------------------- | -------- |
| Line accuracy (product, quantity, price) | 28.8 %               | ≥ 90 %   |
| Price accuracy                           | 28.8 %               | ≥ 97 %   |
| Quantity accuracy                        | 95.5 %               |          |
| Intent accuracy                          | 98.1 %               |          |
| Payment accuracy                         | 97.9 %               |          |
| Customer accuracy                        | 100 %                |          |
| Cases exactly right                      | 44.2 %               |          |
| Extra lines (hallucinated)               | 1                    |          |
| WER (diacritics kept)                    | 26.6 %               |          |
| WER (diacritics stripped)                | 25.7 %               |          |
| Latency p50 / p95 (client)               | 3725 ms / 4941 ms    |          |
| Latency p50 / p95 (server)               | 3681 ms / 4930 ms    |          |
| Cost per utterance                       | $0.00056 (41 priced) | ≤ $0.002 |

## Cases

| Case                         | Intent | Lines | Qty | Price | WER    | Client ms | Result            |
| ---------------------------- | ------ | ----- | --- | ----- | ------ | --------- | ----------------- |
| 01-single-coca               | sale   | 0/1   | 0/1 | 0/1   |        | 4140      | intent ?, payment |
| 02-single-lavie              | sale   | 0/1   | 1/1 | 0/1   | 40 %   | 4322      | lines             |
| 03-single-hao-hao            | sale   | 0/1   | 1/1 | 0/1   | 12.5 % | 3603      | lines             |
| 04-single-tiger              | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3471      | lines             |
| 05-single-trung              | sale   | 0/1   | 1/1 | 0/1   | 25 %   | 2955      | lines             |
| 06-single-no-qty             | sale   | 0/1   | 1/1 | 0/1   | 33.3 % | 3275      | lines             |
| 07-single-sua                | sale   | 0/1   | 1/1 | 0/1   | 33.3 % | 3873      | lines             |
| 08-single-omo                | sale   | 0/1   | 1/1 | 0/1   | 40 %   | 3161      | lines             |
| 09-multi-coca-pepsi          | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 4079      | lines             |
| 10-multi-three               | sale   | 0/3   | 3/3 | 0/3   | 16.7 % | 5136      | lines             |
| 11-multi-beers               | sale   | 0/2   | 2/2 | 0/2   | 72.7 % | 4271      | lines             |
| 12-multi-four                | sale   | 0/4   | 4/4 | 0/4   | 9.5 %  | 4941      | lines             |
| 13-multi-snacks              | sale   | 0/2   | 2/2 | 0/2   | 30.8 % | 3691      | lines             |
| 14-multi-milk-eggs           | sale   | 0/2   | 2/2 | 0/2   | 33.3 % | 4786      | lines             |
| 15-multi-drinks              | sale   | 0/3   | 3/3 | 0/3   | 11.1 % | 3565      | lines             |
| 16-multi-household           | sale   | 0/2   | 2/2 | 0/2   | 33.3 % | 4134      | lines             |
| 17-price-20k                 | sale   | 1/1   | 1/1 | 1/1   | 55.6 % | 3316      | ok                |
| 18-price-hai-chuc            | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 2983      | ok                |
| 19-price-hai-lam             | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3163      | ok                |
| 20-price-muoi-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 42.9 % | 4756      | ok                |
| 21-price-tram-ruoi           | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3969      | ok                |
| 22-price-hai-tram            | sale   | 1/1   | 1/1 | 1/1   | 44.4 % | 4012      | ok                |
| 23-price-bare                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3237      | ok                |
| 24-price-per-item            | sale   | 1/1   | 1/1 | 1/1   | 57.1 % | 4409      | ok                |
| 25-price-line-total          | sale   | 1/1   | 1/1 | 1/1   | 62.5 % | 3226      | ok                |
| 26-price-line-total-mismatch | sale   | 1/1   | 1/1 | 1/1   | 27.3 % | 3355      | ok                |
| 27-price-unit                | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3385      | ok                |
| 28-price-two-lines           | sale   | 2/2   | 2/2 | 2/2   | 38.9 % | 4734      | ok                |
| 29-credit-lan-nuoc-mam       | sale   | 1/1   | 1/1 | 1/1   | 25 %   | 3300      | ok                |
| 30-credit-lan-coca           | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3877      | lines             |
| 31-credit-hung               | sale   | 0/2   | 2/2 | 0/2   | 14.3 % | 4402      | lines             |
| 32-credit-mai                | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3460      | lines             |
| 33-transfer-coca             | sale   | 0/1   | 1/1 | 0/1   | 20 %   | 3140      | lines             |
| 34-transfer-multi            | sale   | 0/2   | 2/2 | 0/2   | 5.9 %  | 4941      | lines             |
| 35-transfer-price            | sale   | 1/1   | 1/1 | 1/1   | 9.1 %  | 3858      | ok                |
| 36-chat-sold-today           | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 2812      | ok                |
| 37-chat-stock                | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 4637      | ok                |
| 38-chat-debt                 | chat   | 0/0   | 0/0 | 0/0   | 0 %    | 3466      | ok                |
| 39-silence                   | none   | 0/0   | 0/0 | 0/0   |        | 1257      | ok                |
| 40-noise-only                | none   | 0/0   | 0/0 | 0/0   |        | 2160      | ok                |
| 41-unknown-rau               | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 5393      | ok                |
| 42-unknown-banh-trang        | sale   | 1/1   | 1/1 | 1/1   | 0 %    | 3626      | ok                |
| 43-unknown-mixed             | sale   | 0/2   | 2/2 | 0/2   | 41.7 % | 3567      | lines             |
| 44-ambiguous-hao-hao         | sale   | 0/1   | 0/1 | 0/1   | 20 %   | 3651      | 1 extra           |
| 45-ambiguous-bia             | sale   | 1/1   | 1/1 | 1/1   | 33.3 % | 3725      | ok                |
| 46-two-speakers-sale         | sale   | 0/2   | 1/2 | 0/2   | 170 %  | 4663      | lines             |
| 47-two-speakers-credit       | sale   | 0/1   | 1/1 | 0/1   | 11.1 % | 3414      | lines             |
| 48-two-speakers-sauce        | sale   | 0/2   | 2/2 | 0/2   | 18.8 % | 4209      | lines             |
| 49-noise-two-line            | sale   | 0/2   | 2/2 | 0/2   | 0 %    | 4118      | lines             |
| 50-noise-price               | sale   | 1/1   | 1/1 | 1/1   | 55.6 % | 3899      | ok                |
| 51-noise-credit              | sale   | 0/1   | 1/1 | 0/1   | 0 %    | 3186      | lines             |
| 52-noise-single              | sale   | 0/1   | 1/1 | 0/1   | 12.5 % | 3831      | lines             |
