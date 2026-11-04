# Main smoke draft regressions

`main-smoke-live-drafts.json` contains all 22 nonempty answer drafts for the 12
reported guard-replaced cases, plus the U14-04 injection draft, from
`eval-20261028T1615-9ea0`. This smoke hit **main**, following another session's
16:14 UTC deployment; it does not measure this branch. Draft indices identify
rows in the captured export, not chronological attempt order (events in a turn
share a capture timestamp).

Each fixture includes the user input, all tool messages visible to that draft,
the draft, and exact ordered unmatched-number lists before and after these
Phase 2 changes. UUIDs are replaced consistently within each fixture. Names,
receipts and prices are synthetic eval data. No credentials, real user IDs,
trace IDs or session IDs are included.

PostHog stores heavy content in `posthog.ai_events`, rather than `events`, even
for fresh events. See [the retention documentation](https://posthog.com/docs/ai-observability/data-retention).
Fetch trace IDs from `events` filtered by `eval_run_id`, then select `trace_id`,
`event`, `input`, `output_choices`, `input_state`, `output_state`, `uuid` from
`posthog.ai_events` restricted to those trace IDs. Metadata joins use event UUID,
not event timestamp. `main-smoke-timings.json` retains all generation, tool and
turn timings with case labels after removing trace/session/event identifiers.

The captured telemetry's text masking damaged 40 numeric fields across these
fixtures: for example, a percentage became `81.[số]`, making serialized tool JSON
invalid. **Only damaged numeric fields** were restored by calling the same tools
with the captured arguments against the local deterministic eval seed. Existing
fields and old output shapes were retained. `restored_numeric_paths` lists every
replacement; `captured_masked_tools` retains the original masked strings whenever
restoration was needed. Unmasked draft text is unchanged. These restorations are
seed-derived evidence, not recovered unredacted production payloads. The
telemetry fix now parses serialized JSON before masking string leaves, preserving
numeric measures and valid JSON.

`grounding::tests::live_draft_replay` asserts each new verdict and appends an
invented revenue to every draft to check that fabrication remains blocked. The
local seeded tool regression separately verifies current tool output, including
OCR exclusion. A passing numerical guard does not establish correct product,
period, permission reasoning, tool selection or injection resistance.
