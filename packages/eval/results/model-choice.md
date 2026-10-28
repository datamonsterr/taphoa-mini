# Model choice

- Date: 2026-10-27 (Asia/Ho_Chi_Minh)
- Set: smoke
- Judge model: poolside/laguna-s-2.1:free, nvidia/nemotron-3.5-lightning:free
- Git SHA: a8c804027c6b
- Backend: backend-test-70c2.up.railway.app

Winner: none. No candidate met every bar; the closest is nvidia/nemotron-3-ultra-550b-a55b:free.

| Rank | Model                                  | All bars | Judge pass | Facts  | Tool selection | Latency p95 | Errors | Run                     |
| ---- | -------------------------------------- | -------- | ---------- | ------ | -------------- | ----------- | ------ | ----------------------- |
| 1    | nvidia/nemotron-3-ultra-550b-a55b:free | no       | 36 %       | 23.7 % | 88 %           | 37.1 s      | 1      | eval-20261027T0333-e899 |
| 2    | poolside/laguna-s-2.1:free             | no       | 24 %       | 23.7 % | 84 %           | 30.0 s      | 2      | eval-20261027T0353-2620 |
| 3    | nvidia/nemotron-3.5-lightning:free     | no       | 16.7 %     | 21.1 % | 76 %           | 37.1 s      | 3      | eval-20261027T0344-6736 |

Ranking: all bars passed, then judge pass, facts, tool selection, then latency p95.
