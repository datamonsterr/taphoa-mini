# Assistant pricing and online judge (#63)

These dependency-free ESM tools use the existing read-only `../lib/client.mjs`
and `../lib/secrets.mjs` helpers. Credentials come from
`~/.config/taphoa-mini/secrets.env` (mode `600`), or environment variables:
`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST`.
Never put credential values in definitions, command arguments, or reports.

## Commands

Run from the repository root. Apply defaults to a read-only dry run. Query POSTs
are reads; only evaluation apply and the explicitly requested one-generation run
write to PostHog. No command deletes objects, edits backend code, or creates
dashboards/insights.

```sh
node infra/posthog/llm/pricing-apply.mjs --dry-run
node infra/posthog/llm/pricing-apply.mjs --apply
node infra/posthog/llm/pricing-verify.mjs

node infra/posthog/llm/evaluations-apply.mjs --dry-run
node infra/posthog/llm/evaluations-apply.mjs --apply
node infra/posthog/llm/evaluations-apply.mjs --apply # unchanged on second apply
node infra/posthog/llm/evaluations-verify.mjs

# After configuring the judge provider, optionally score ONE existing test event:
node infra/posthog/llm/evaluations-run.mjs --dry-run
node infra/posthog/llm/evaluations-run.mjs --apply
# Async run acceptance is not a score. Verify again after processing/ingestion:
node infra/posthog/llm/evaluations-verify.mjs
```

Verification exits `1` for incomplete evidence, missing events, configuration
drift, disabled judge, or missing scores. It never treats zero rows as success.
Only aggregate costs, score bounds, model IDs, and configuration metadata are
printed; generation content and user identifiers are not printed.

## Pricing capability and backend handoff

The current [PostHog cost documentation](https://posthog.com/docs/llm-analytics/calculating-costs)
documents custom pricing on each event, **not a project-level pricing table or a
public pricing CRUD endpoint**. The [public API reference](https://posthog.com/docs/api)
does not expose such a table. There is no documented dashboard pricing-table
setup to automate or provide manual table-editing instructions for.
`pricing-apply.mjs` therefore returns `event_properties_required`, zero remote
changes, and the event properties for every model; `--apply` cannot install
project pricing. Repeated runs with the same catalog produce the same plan.

PostHog documents these alternatives (USD per **individual token**, not per million):

1. Send **both** `$ai_input_token_price` and `$ai_output_token_price` on each
   `$ai_generation`; PostHog computes costs from the token counts.
2. Send `$ai_input_cost_usd` and `$ai_output_cost_usd` as precomputed costs.
   PostHog uses those values directly. Precomputed costs take precedence over
   custom token prices, which take precedence over automatic matching.

The code emits zero token prices for these deployed models:

| Model                                    | Input USD/token | Output USD/token |
| ---------------------------------------- | --------------- | ---------------- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 0               | 0                |
| `poolside/laguna-s-2.1:free`             | 0               | 0                |
| `nvidia/nemotron-3.5-lightning:free`     | 0               | 0                |
| `google/gemma-4-31b-it:free`             | 0               | 0                |
| `nvidia/nemotron-3-super-120b-a12b:free` | 0               | 0                |

The last model is the older fallback in `apps/backend/.env.example`, root
`.env.example`, and `apps/backend/crates/api/src/assistant/config.rs`. The current
backend rejects paid models (`:free` is required). No paid fallback is configured;
paid model strings in unit tests are rejection fixtures.

Every pricing run fetches the public, unauthenticated
[OpenRouter model catalog](https://openrouter.ai/api/v1/models).
All four deployed models currently advertise `prompt: "0", completion: "0"`.
The legacy fallback is absent; it retains zero pricing by explicit `:free` policy.
Nonzero catalog prices for a `:free` model fail validation. Paid models supplied
through `ASSISTANT_MODELS` must exist in the live catalog; no hardcoded paid price
is used. Nonzero extra billing components fail closed pending formula review.
An override replaces the default pricing verification model list; the judge's
versioned scope remains the five model IDs in `evaluations.mjs`.

**Backend change needed for explicit custom token pricing (not implemented here):**
in `apps/backend/crates/api/src/assistant/telemetry.rs`, where `turn_finished`
constructs each generation, add both zero token-price properties for free models.
It already sends zero input/output/total costs for free models, satisfying
PostHog's documented precomputed-cost route. To demonstrate custom calculation
rather than passthrough, omit precomputed costs on new generations and send the
two token prices with the existing model/provider/token fields. If paid models
are later allowed, use reviewed OpenRouter rates (and cache/request/search
components where applicable), or actual provider-reported costs; do not send
zero paid costs. Event pricing does not retroactively reprice old events.

`pricing-verify.mjs` uses `POST /api/projects/<id>/query/` with `HogQLQuery`
(`costQuery` is exported). It checks each model separately over 30 days of
`environment=test`, `$ai_provider=openrouter`, `$ai_generation` events: missing
tokens, missing cost components, mismatches in input/output/total costs, and
PostHog's `$ai_cost_model_source`. Zero pricing requires exactly zero costs;
paid formulas allow USD `1e-12` rounding error. Stored zeros alone cannot prove
that newly configured custom token pricing was used.

## Online judge and supported APIs

The [evaluations documentation](https://posthog.com/docs/llm-analytics/evaluations)
and [evaluations API reference](https://posthog.com/docs/api/evaluations) expose
evaluation listing, creation, and PATCH updates. The tools use:

| Endpoint relative to `/api/projects/<id>/` | Use                                                 |
| ------------------------------------------ | --------------------------------------------------- |
| `llm_analytics/models/?provider=openai`    | Confirm `gpt-4.1-mini` is offered                   |
| `llm_analytics/evaluation_config/`         | Read active provider connection ID                  |
| `llm_analytics/provider_keys/`             | Read connection health/provider metadata            |
| `evaluations/`, `evaluations/<uuid>/`      | Upsert by exact managed name                        |
| `evaluation_runs/`                         | Explicit async run for one existing test generation |
| `query/`                                   | Read cost/score evidence through HogQL              |

The provider/model and run wire contracts are also defined in PostHog's public
[model catalog API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/models.py),
[provider connection API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/provider_keys.py),
and [evaluation run API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/evaluation_runs.py).
These are real APIs, not dashboard-only capabilities. Personal API key permissions
must permit evaluation reads/writes, provider metadata reads, and HogQL queries.

The managed evaluation is `taphoa-assistant-vietnamese-quality-v1`:

- `evaluation_type=llm_judge`, `target=generation`, `judge_method=llm`.
- OpenAI `gpt-4.1-mini`, checked against PostHog's live model catalog and pinned
  to the active healthy OpenAI connection when available.
- Numeric 0–4 Vietnamese rubric: grounded numbers, Vietnamese language,
  usefulness, and respect for permissions/secrets. Invented numbers or a
  permission/security violation forces zero. Passing threshold is 4.
- Two OR conditions: `environment=test` sampled **100%** and
  `environment=production` sampled **10%**. Each condition also requires
  `$ai_provider=openrouter` and an explicit assistant model. No `eval` traffic is
  relabeled as `test`; no unrelated generations are selected.
- Missing/unhealthy active OpenAI connection means the object is saved disabled,
  with an explicit blocker in the apply summary. Rerunning after setup enables
  the same object. A duplicate managed name aborts; unrelated objects are left alone.

The live catalog advertised `requires_provider_key=false`, but a real enabled
create was rejected with HTTP 400, `Add a provider API key to enable this
evaluation.` Consequently the code requires a healthy active OpenAI connection
before enabling. It never copies credentials from the backend or provisions keys.

### Manual provider setup and dashboard inspection

1. Open the intended PostHog project, then **Settings → AI Observability**
   (older navigation calls the product LLM analytics).
2. In AI provider connections/API keys, add an **OpenAI** connection using the
   owner's provider key; save it and set it as the active/default connection.
   The connection must pass validation. Do not paste the key into this repository.
3. Rerun `evaluations-apply.mjs --dry-run`, then `--apply`. It should update the
   existing judge to enabled, with the connection UUID pinned.
4. Open **AI Evals → Evaluations → taphoa-assistant-vietnamese-quality-v1**.
   Confirm **Each generation**, **LLM with explanation**, **gpt-4.1-mini**,
   numeric scale **0–4**, passing **≥4**, and both property-filter groups:
   test **100%**, production **10%**, OpenRouter and the configured model IDs.
5. Run `evaluations-run.mjs --dry-run`, then `--apply` to enqueue one existing
   successful test generation. It reuses real captured content and creates no
   synthetic generation. The request is asynchronous and may incur judge cost.
   It skips when linked test score evidence already exists; avoid repeating while
   a run is pending, since the run API creates a new workflow on each request.
6. Run `evaluations-verify.mjs` after processing. In PostHog, open the evaluation's
   run history, then the linked generation/trace to inspect the numeric score and
   explanation. Alternatively use the evaluation's **Backfills** tab for a chosen
   historical test-only interval, following the documented backfill steps.

Online sampling evaluates **new** events after creation/enabling; it does not
automatically score the previous 30 days. PostHog now supports explicit runs and
backfills, so lack of automatic history scoring is not an API limitation.
`evaluations-verify.mjs` filters numeric `$ai_evaluation` results for this UUID
and joins `$ai_target_event_id` to a real test generation UUID. It does not rely
on `environment` being copied onto the evaluation event. Existence of a judge
object, queued run, or preview result is not accepted as score proof. Automatic
new-event sampling and production 10% behavior remain live acceptance for #66.

## Live evidence (2026-10-28)

Against the configured real project:

- Pricing plan: five zero-price model definitions, zero project pricing writes
  because no public project pricing CRUD capability is documented.
- Judge first successful apply: **create 1**, paused/disabled because there is
  no provider connection. Evaluation UUID:
  `01a182a2-bbe6-0000-92f8-955540555f4b`.
- Second judge apply: **unchanged, changes 0**, same UUID, paused.
- Last-30-day test cost verification: Nemotron Ultra **52** generations,
  **0** missing tokens, **0** missing costs, **0** mismatches, **$0** total.
  PostHog reports cost source `openrouter`.
- Laguna, Lightning, Gemma, and legacy Super: **0 test generations** in this
  window. Separate discovery found Laguna **49** and Lightning **5** under
  `environment=eval`; those do not satisfy test acceptance.
- Judge verification query: configuration matches, **0 scores**, paused/disabled,
  overall `passed=false`. Judge score proof is blocked by the absent provider connection. No passing
  score result or automatic production sampling is claimed. Configure the
  provider and rerun the commands above; fill model/event coverage in #66.

## Local validation

```sh
node --test infra/posthog/llm
npx --yes prettier@3.9.10 --check 'infra/posthog/llm/*.mjs' infra/posthog/llm/README-pricing-judge.md
```

The exact directory command works on the installed Node 26. For Node 24 (the
repository's required runtime), use explicit files:

```sh
node --test infra/posthog/llm/*.test.mjs
```

Node 24 resolves an explicitly passed directory as a module; it requires a
`package.json`/entrypoint there. Adding `llm/package.json` would exceed this
task's strict `pricing*`/`evaluations*`/README write boundary, so no metadata
exception was made. The actual ESM tools and tests run on Node 24 with no npm
runtime dependencies. Tests use isolated fakes; they are separate from the
real-project evidence and incomplete live acceptance above.
