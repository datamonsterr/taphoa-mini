import {
  assistantModels,
  hogql,
  legacyModels,
  liveClient,
  main,
  parseMode,
  sqlString,
} from './pricing.mjs';
import { managedEvaluation, verifyEvaluation } from './evaluations-verify.mjs';

export async function runOne(client, { dryRun = true } = {}) {
  const evaluation = await managedEvaluation(client);
  const evidence = await verifyEvaluation(client);
  if (
    !evidence.configurationMatches ||
    !evaluation.enabled ||
    evaluation.status === 'error'
  )
    throw new Error(
      'Apply and enable the managed judge before requesting a run',
    );
  if (evidence.scores > 0)
    return {
      dryRun,
      action: 'unchanged',
      reason: 'Existing test score already proves judge execution',
    };
  const rows = await hogql(
    client,
    `SELECT toString(uuid), timestamp FROM events
    WHERE event = '$ai_generation' AND properties.environment = 'test'
      AND properties.$ai_provider = 'openrouter'
      AND properties.$ai_model IN (${[...assistantModels, ...legacyModels].map(sqlString).join(', ')})
      AND properties.$ai_is_error = false
      AND isNotNull(properties.$ai_input) AND isNotNull(properties.$ai_output_choices)
      AND timestamp >= now() - INTERVAL 30 DAY ORDER BY timestamp DESC LIMIT 1`,
  );
  if (!rows.length)
    throw new Error(
      'No successful existing test generation with input/output; prove live sampling in #66',
    );
  const [target_event_id, timestamp] = rows[0];
  const payload = {
    evaluation_id: evaluation.id,
    target_event_id,
    timestamp: new Date(
      `${timestamp.replace(' ', 'T')}${/[zZ]|[+-]\d\d:\d\d$/.test(timestamp) ? '' : 'Z'}`,
    ).toISOString(),
    event: '$ai_generation',
  };
  const result = dryRun ? null : await client.post('evaluation_runs/', payload);
  return {
    dryRun,
    action: 'run_one',
    payload,
    status: result?.status ?? 'planned',
    note: 'Async request is not score proof; run evaluations-verify after ingestion. Run may incur judge cost.',
  };
}

main(import.meta, async () =>
  console.log(
    JSON.stringify(
      await runOne(liveClient(), parseMode(process.argv.slice(2))),
      null,
      2,
    ),
  ),
);
