import {
  assistantModels,
  hogql,
  legacyModels,
  liveClient,
  main,
  sqlString,
} from './pricing.mjs';
import {
  evaluationName,
  judgeDefinition,
  judgeModel,
  matches,
} from './evaluations.mjs';

export async function managedEvaluation(client) {
  const found = (await client.listAll('evaluations/')).filter(
    (e) => !e.deleted && e.name === evaluationName,
  );
  if (found.length !== 1)
    throw new Error(
      'Expected exactly one managed judge; run evaluations-apply first',
    );
  return found[0];
}

export function resultsQuery(id) {
  return `SELECT count() AS scores, min(e.score) AS min_score,
    max(e.score) AS max_score, groupUniqArray(g.model) AS models
    FROM (
      SELECT toString(properties.$ai_target_event_id) AS target_id,
        toFloat(properties.$ai_evaluation_numeric_result) AS score
      FROM events WHERE event = '$ai_evaluation'
        AND properties.$ai_evaluation_id = ${sqlString(id)}
        AND timestamp >= now() - INTERVAL 30 DAY
        AND isNotNull(properties.$ai_evaluation_numeric_result)
        AND properties.$ai_evaluation_numeric_result >= 0 AND properties.$ai_evaluation_numeric_result <= 4
        AND (isNull(properties.$ai_evaluation_skipped) OR properties.$ai_evaluation_skipped = false)
    ) AS e JOIN (
      SELECT toString(uuid) AS generation_id, toString(properties.$ai_model) AS model
      FROM events WHERE event = '$ai_generation' AND properties.environment = 'test'
        AND properties.$ai_provider = 'openrouter'
        AND properties.$ai_model IN (${[...assistantModels, ...legacyModels].map(sqlString).join(', ')})
        AND timestamp >= now() - INTERVAL 30 DAY
    ) AS g ON g.generation_id = e.target_id`;
}

export async function verifyEvaluation(client) {
  const evaluation = await managedEvaluation(client);
  const configurationMatches = matches(
    evaluation,
    judgeDefinition(await judgeModel(client)),
  );
  const rows = await hogql(client, resultsQuery(evaluation.id));
  if (
    rows.length !== 1 ||
    rows[0].length !== 4 ||
    !Number.isInteger(rows[0][0]) ||
    rows[0][0] < 0
  )
    throw new Error('Invalid evaluation result counts');
  const [scores, min_score, max_score, models] = rows[0];
  return {
    passed:
      configurationMatches &&
      evaluation.enabled &&
      evaluation.status !== 'error' &&
      scores > 0,
    configurationMatches,
    id: evaluation.id,
    enabled: evaluation.enabled,
    status: evaluation.status,
    scores,
    min_score,
    max_score,
    models,
    proof:
      'PostHog numeric evaluation events joined by target UUID to existing test assistant generations.',
    next: scores
      ? null
      : 'Online evaluations grade new events; run evaluations-run.mjs --apply on one existing test generation, or prove new-event sampling in #66.',
  };
}

main(import.meta, async () => {
  if (process.argv.length > 2)
    throw new Error('evaluations-verify takes no arguments');
  const result = await verifyEvaluation(liveClient());
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
});
