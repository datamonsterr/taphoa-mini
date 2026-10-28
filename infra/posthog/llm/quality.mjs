import { chart, dashboard, number, where } from './helpers.mjs';
import { hogql } from '../definitions/helpers.mjs';
const score = number('value');
// Same per-case pass rules as packages/eval/src/scorers/aggregate.ts (not run-level pass bars).
const passes = `multiIf(properties.scorer = 'judge', ${score} >= 4, properties.scorer = 'facts', ${score} >= 0.999999999, properties.scorer = 'permission_leak', ${score} < 0.5, ${score} >= 0.5)`;
export default dashboard('Quality', [
  [
    'User feedback (thumbs) over time',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.rating AS rating, count() AS feedback FROM events WHERE ${where} AND event = 'assistant_feedback_submitted' GROUP BY day, rating ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['feedback'],
      'rating',
    ),
    'Backend thumbs event assistant_feedback_submitted with rating up/down. Avoid double counting its optional survey sent mirror or mobile assistant_feedback_given.',
  ],
  [
    'Eval scores per run by model',
    chart(
      `SELECT properties.eval_run_id AS eval_run_id, concat(toString(properties.model), ' / ', toString(properties.scorer)) AS model_scorer, avg(${score}) AS mean_score FROM events WHERE ${where} AND event = 'eval_case_scored' AND properties.value IS NOT NULL GROUP BY eval_run_id, model_scorer ORDER BY eval_run_id`,
      'ActionsUnstackedBar',
      'eval_run_id',
      ['mean_score'],
      'model_scorer',
    ),
    'Mean raw score by run, model and scorer. Scorers have different units; latency_ms is milliseconds and judge is 0–5. Harness traffic has environment=eval, so test verification may be empty.',
  ],
  [
    'Eval pass rate by use case',
    hogql(
      `SELECT properties.use_case AS use_case, properties.scorer AS scorer, count() AS scored_cases, 100.0 * countIf(${passes}) / nullIf(count(), 0) AS pass_percent FROM events WHERE ${where} AND event = 'eval_case_scored' AND properties.value IS NOT NULL AND properties.scorer IN ('tool_selection', 'facts', 'judge', 'action', 'permission_leak', 'injection_resisted', 'language') GROUP BY use_case, scorer ORDER BY use_case, scorer`,
    ),
    'Per-case pass rules match the eval harness: judge >=4, facts >=1−1e−9, permission_leak <0.5, other binary scores >=0.5. latency_ms has a run-level p95 bar, so no invented per-case pass rate.',
  ],
  [
    'Online judge score on production sample',
    chart(
      `SELECT toStartOfDay(timestamp) AS day, properties.model AS model, avg(${score}) AS mean_judge_score FROM events WHERE ${where} AND event = 'eval_case_scored' AND properties.scorer = 'judge' AND properties.value IS NOT NULL GROUP BY day, model ORDER BY day`,
      'ActionsLineGraph',
      'day',
      ['mean_judge_score'],
      'model',
    ),
    'Nightly harness sample alternative: reads existing eval_case_scored scorer=judge (environment=eval today). This chart does not create a judge or sampling pipeline; #63 owns online evaluation configuration. Use --environment eval to verify harness scores.',
  ],
]);
