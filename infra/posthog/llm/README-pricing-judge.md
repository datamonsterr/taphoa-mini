# Assistant pricing and online judge (#63)

These dependency-free ESM tools use the existing `../lib/client.mjs`
and `../lib/secrets.mjs` helpers. Credentials come from
`~/.config/taphoa-mini/secrets.env` (mode `600`), or environment variables:
`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST`. Provider setup
also reads the dedicated `OPENROUTER_POSTHOG_JUDGE_KEY` at runtime (environment
overrides the file); it never reads the assistant backend key.
Never put credential values in definitions, command arguments, or reports.

## Commands

Run from the repository root. Apply defaults to a read-only dry run. Query POSTs
are reads; provider setup, evaluation apply, and the explicitly requested
one-generation run write to PostHog. No command deletes objects, edits backend code, or creates
dashboards/insights.

```sh
node infra/posthog/llm/pricing-apply.mjs --dry-run
node infra/posthog/llm/pricing-apply.mjs --apply
node infra/posthog/llm/pricing-verify.mjs

node infra/posthog/llm/evaluations-provider.mjs --dry-run
node infra/posthog/llm/evaluations-provider.mjs --apply
node infra/posthog/llm/evaluations-provider.mjs --apply # unchanged on second apply
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

The assistant default is now `z-ai/glm-5.3-flash`, with
`nvidia/nemotron-3.5-lightning:free` as a last resort. Paid IDs are accepted in
`ASSISTANT_MODELS`; malformed/empty IDs fail startup validation. The separate eval
judge is `google/gemini-2.5-flash` (90% calibration agreement, MAE 0.5); it never
judges its own answers. The online PostHog judge below is independently configured.

Every pricing run fetches the public [OpenRouter model catalog](https://openrouter.ai/api/v1/models)
and paid models' [provider endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model).
Prices are USD per token. Paid models must exist in the catalog and have endpoints;
no paid rate is hardcoded. Verification includes historical free models, whose
explicit `:free` policy requires zero cost even after retirement from the catalog.
Known optional cache, context-tier, reasoning and modality charges are validated;
unknown nonzero components fail closed. The cost check covers text generations.

The backend consumes the **final SSE usage chunk**. Current [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
is automatic; `usage.include` and `stream_options.include_usage` are deprecated.
`usage.cost` is the actual account charge. The backend emits it as
`$ai_total_cost_usd`, and emits `$ai_input_cost_usd` / `$ai_output_cost_usd` from
`cost_details.upstream_inference_prompt_cost` /
`upstream_inference_completions_cost` when their sum reconciles with that charge.
Unreported costs remain missing, never zero-filled for paid models. `:free`
generations still emit explicit zero costs. The optional SSE `usage.cost` also
lets the harness report actual cost per completed turn across all model calls.

`pricing-verify.mjs` checks each model over 30 days of `environment=test`,
`$ai_provider=openrouter`, `$ai_generation` events. It requires token counts and
all three cost fields. Free costs must be exactly zero. Paid input/output costs
must lie within the live catalog/provider price bounds, including cache and
context tiers, with **10% relative + USD 1e-8 absolute** tolerance. The total must
match the reported components to USD 1e-8. Endpoint price bounds matter because
latency routing can choose a provider above the catalog's cheapest advertised
rate. Missing events/accounting and invalid sums fail verification. This bounded
comparison does not prove the exact selected provider price; actual accounting
is authoritative and stored precomputed costs do not prove PostHog calculated them.

No PostHog pricing writes or historical repricing occur. No online judge/provider
changes are applied as part of the local eval task.

## Online judge and supported APIs

The [evaluations documentation](https://posthog.com/docs/llm-analytics/evaluations)
and [evaluations API reference](https://posthog.com/docs/api/evaluations) expose
evaluation listing, creation, and PATCH updates. The tools use:

| Endpoint relative to `/api/projects/<id>/`                | Use                                                 |
| --------------------------------------------------------- | --------------------------------------------------- |
| `llm_analytics/models/?provider=openrouter&key_id=<uuid>` | Select a free judge from the connection catalog     |
| `llm_analytics/evaluation_config/`                        | Read active provider connection ID                  |
| `llm_analytics/provider_keys/`                            | Find or create the dedicated OpenRouter connection  |
| `llm_analytics/evaluation_config/set_active_key/`         | Activate the healthy connection using `key_id`      |
| `evaluations/`, `evaluations/<uuid>/`                     | Upsert by exact managed name                        |
| `evaluation_runs/`                                        | Explicit async run for one existing test generation |
| `query/`                                                  | Read cost/score evidence through HogQL              |

The provider/model and run wire contracts are also defined in PostHog's public
[model catalog API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/models.py),
[provider connection API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/provider_keys.py),
[active evaluation connection API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/evaluation_config.py),
and [evaluation run API source](https://github.com/PostHog/posthog/blob/master/products/ai_observability/backend/api/evaluation_runs.py).
These are real APIs, not dashboard-only capabilities. Personal API key permissions
must permit evaluation reads/writes, provider connection reads/writes, and HogQL queries.

The managed evaluation is `taphoa-assistant-vietnamese-quality-v1`:

- `evaluation_type=llm_judge`, `target=generation`, `judge_method=llm`.
- OpenRouter, pinned to the active healthy `taphoa-mini-posthog-judge` connection.
  `evaluations.mjs` selects the first model offered by PostHog in this order:
  `nvidia/nemotron-3.5-super-vl:free`, `poolside/laguna-s-2.1:free`,
  `nvidia/nemotron-3.5-lightning:free`. Set `POSTHOG_JUDGE_MODEL` consistently for
  apply/run/verify to override selection. The override must be catalog-backed,
  end in `:free`, and differ from the assistant's first model
  `nvidia/nemotron-3-ultra-550b-a55b:free`; paid models are rejected.
- Numeric 0–4 Vietnamese rubric: grounded numbers, Vietnamese language,
  usefulness, and respect for permissions/secrets. Invented numbers or a
  permission/security violation forces zero. Passing threshold is 4.
- Two OR conditions: `environment=test` sampled **100%** and
  `environment=production` sampled **10%**. Each condition also requires
  `$ai_provider=openrouter` and an explicit assistant model. No `eval` traffic is
  relabeled as `test`; no unrelated generations are selected.
- A missing/unhealthy managed active connection saves the judge disabled with
  an explicit blocker. Rerunning after provider setup enables the same object.
  A duplicate managed evaluation or connection name aborts; unrelated objects
  are left alone.

### OpenRouter provider setup and dashboard inspection

1. Store the dedicated, $1-limited key in the private secrets file as
   `OPENROUTER_POSTHOG_JUDGE_KEY`. Do not put the value in command arguments.
   Provider setup dry-run lists the plan without loading the credential.
2. Run `evaluations-provider.mjs --dry-run`, then `--apply`. It finds the exact
   managed name or creates an `openrouter` connection with write-only `api_key`
   and `set_as_active=true`. The API validates the credential before creation.
   Existing unhealthy or wrong-provider connections fail without overwriting a
   credential. An existing healthy inactive connection is activated with
   `POST evaluation_config/set_active_key/` and `{key_id: <uuid>}`. This changes
   the project's default evaluation connection; the managed judge also pins it.
3. Rerun provider apply: expect `unchanged`, `changes=0`, `state=ok`, `active=true`.
   Output contains only allowlisted metadata. Entire provider API errors are
   redacted, including responses that might echo partial credential values.
4. Run `evaluations-apply.mjs --dry-run`, then `--apply`, then repeat `--apply`.
   Expect the same evaluation UUID, enabled/active, then `unchanged` and zero
   changes. The model catalog requires `key_id` even after activation; the
   provider-only request can still return zero models and
   `requires_provider_key=true`.
5. In PostHog, open **AI Evals → Evaluations →
   taphoa-assistant-vietnamese-quality-v1**. Confirm **Each generation**,
   **LLM with explanation**, provider **OpenRouter**, the selected free model,
   numeric scale **0–4**, passing **≥4**, and both property-filter groups:
   test **100%**, production **10%**, OpenRouter and the configured model IDs.
6. Run `evaluations-run.mjs --dry-run`, then `--apply` to enqueue one existing
   successful test generation **with captured input/output**. It creates no
   synthetic generation. Missing captured content fails before enqueueing;
   fresh test traffic is needed in that case. The request is asynchronous.
   It skips when linked test score evidence already exists; avoid repeating while
   a run is pending, since the run API creates a new workflow on each request.
7. After an accepted run, poll `evaluations-verify.mjs` about every 30–60 seconds
   for up to ten minutes. A queued request is not proof of a score. In PostHog,
   open the evaluation's run history, then the linked generation/trace to inspect
   the numeric score and explanation. The **Backfills** tab also supports a
   chosen historical test-only interval with captured content.

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
- Dedicated provider apply: **create 1**, healthy (`state=ok`), active.
  Connection name `taphoa-mini-posthog-judge`, UUID
  `01a1831d-0b76-0000-59f5-009cbe683cb1`; second apply **unchanged, changes 0**.
- The connection-scoped OpenRouter catalog offered **456 models**, including all
  three preferred free judges. Selected `nvidia/nemotron-3.5-super-vl:free`.
- Judge apply: **update 1**, existing UUID
  `01a182a2-bbe6-0000-92f8-955540555f4b`, **enabled=true**, **status=active**,
  provider **openrouter**, pinned to the dedicated connection. Test sampling
  remains **100%**, production **10%**. Second apply: **unchanged, changes 0**.
- Earlier last-30-day test cost verification: Nemotron Ultra **52** generations,
  **0** missing tokens, **0** missing costs, **0** mismatches, **$0** total.
  PostHog reports cost source `openrouter`. This pricing result was retained
  from the earlier #63 verification; it was not rerun for this provider change.
- Laguna, Lightning, Gemma, and legacy Super had **0 test generations** in the
  earlier window. Separate discovery found Laguna **49** and Lightning **5**
  under `environment=eval`; those do not satisfy test acceptance.
- `evaluations-run.mjs --apply` was attempted and exited **1** before enqueueing:
  `No successful existing test generation with input/output`. Aggregate live
  inspection found **52** test generations (**51** successful, **1** error),
  all missing `$ai_input` and `$ai_output_choices`. The content-required selector
  was retained; no empty-content judge run or synthetic traffic was submitted.
- Final `evaluations-verify.mjs`: **configurationMatches=true**, **enabled=true**,
  **status=active**, **scores=0**, **passed=false** (exit **1**). There was no
  accepted workflow to poll. The provider blocker is resolved; actual score
  proof requires fresh test generations with captured content in **#66**.
  Automatic new-event sampling and production 10% execution remain unproven.

## Local validation

```sh
node --test infra/posthog/llm/*.test.mjs
pnpm exec prettier --check 'infra/posthog/llm/evaluations*.mjs' infra/posthog/llm/README-pricing-judge.md
```

Tests use isolated fakes and cover provider creation/activation/idempotency,
secret loading/redaction, free-model selection and overrides, judge upsert and
sampling, configuration verification, and content-required single-event runs.
The local commands were run with Node **26.12.0**, which emits an engine warning
because the repository requires Node **24**. The explicit test-file command is
also suitable for Node 24; no Node 24 run is claimed here. Local tests do not
replace the real-project evidence or pending live score acceptance above.
