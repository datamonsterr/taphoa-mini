import { main, liveClient, parseMode } from './pricing.mjs';
import {
  evaluationName,
  judgeDefinition,
  judgeModel,
  matches,
} from './evaluations.mjs';

export async function applyEvaluation(client, { dryRun = true } = {}) {
  const desired = judgeDefinition(await judgeModel(client));
  const found = (await client.listAll('evaluations/')).filter(
    (e) => !e.deleted && e.name === evaluationName,
  );
  if (found.length > 1)
    throw new Error(`Ambiguous evaluation name: ${evaluationName}`);
  const existing = found[0];
  const action =
    existing && matches(existing, desired)
      ? 'unchanged'
      : existing
        ? 'update'
        : 'create';
  let object = existing;
  if (!dryRun && action !== 'unchanged')
    object = existing
      ? await client.patch(
          `evaluations/${encodeURIComponent(existing.id)}/`,
          desired,
        )
      : await client.post('evaluations/', desired);
  if (!dryRun && (!matches(object, desired) || object.status === 'error'))
    throw new Error(
      'Saved evaluation differs from definition or is in error state',
    );
  return {
    dryRun,
    action,
    changes: action === 'unchanged' ? 0 : 1,
    id: object?.id ?? null,
    enabled: object?.enabled ?? desired.enabled,
    status: object?.status ?? 'planned',
    blocker: desired.enabled
      ? null
      : 'No active healthy OpenAI connection. Add one in Settings > AI Observability and rerun apply to enable; scores are unproven.',
    definition: desired,
  };
}

main(import.meta, async () =>
  console.log(
    JSON.stringify(
      await applyEvaluation(liveClient(), parseMode(process.argv.slice(2))),
      null,
      2,
    ),
  ),
);
