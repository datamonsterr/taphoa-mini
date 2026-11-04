import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeKeyId, providerKeyName } from './evaluations.mjs';
import { liveClient, main, parseMode } from './pricing.mjs';

export function loadJudgeKey({
  path = join(homedir(), '.config/taphoa-mini/secrets.env'),
  env = process.env,
} = {}) {
  // Keep this dedicated credential out of shared client configuration and errors.
  let key = env.OPENROUTER_POSTHOG_JUDGE_KEY;
  if (key === undefined) {
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) throw new Error();
      const line = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .find((value) => /^\s*OPENROUTER_POSTHOG_JUDGE_KEY\s*=/.test(value));
      key = line
        ?.replace(/^\s*OPENROUTER_POSTHOG_JUDGE_KEY\s*=\s*/, '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
    } catch {
      throw new Error(
        'Cannot read judge credential: secrets file must be readable and mode 600',
      );
    }
  }
  if (!key?.trim())
    throw new Error('Missing required key: OPENROUTER_POSTHOG_JUDGE_KEY');
  return key;
}

async function providerRequest(run) {
  try {
    return await run();
  } catch {
    // Provider validation responses may echo credentials, including partial values.
    // Suppress the entire untrusted response, rather than only replacing the full key.
    throw new Error('PostHog provider request failed; response [REDACTED]');
  }
}

export async function applyProvider(
  client,
  { dryRun = true, readKey = loadJudgeKey } = {},
) {
  const keys = await providerRequest(() =>
    client.listAll('llm_analytics/provider_keys/'),
  );
  const found = keys.filter((key) => key.name === providerKeyName);
  if (found.length > 1) throw new Error('Ambiguous managed provider key name');
  let key = found[0];
  const check = () => {
    if (
      key &&
      (key.provider !== 'openrouter' ||
        key.state !== 'ok' ||
        key.name !== providerKeyName ||
        !key.id)
    )
      throw new Error(
        'Managed provider connection must be a healthy OpenRouter key; no credential overwritten',
      );
  };
  check();
  let config = await providerRequest(() =>
    client.get('llm_analytics/evaluation_config/'),
  );
  const action = !key
    ? 'create'
    : activeKeyId(config) === key.id
      ? 'unchanged'
      : 'activate';
  let changes = action === 'unchanged' ? 0 : 1;
  if (!dryRun && !key) {
    const apiKey = readKey();
    key = await providerRequest(() =>
      client.post('llm_analytics/provider_keys/', {
        name: providerKeyName,
        provider: 'openrouter',
        api_key: apiKey,
        set_as_active: true,
      }),
    );
    check();
    if (!key)
      throw new Error('PostHog did not return a managed provider connection');
    config = await providerRequest(() =>
      client.get('llm_analytics/evaluation_config/'),
    );
  }
  if (!dryRun && activeKeyId(config) !== key.id) {
    await providerRequest(() =>
      client.post('llm_analytics/evaluation_config/set_active_key/', {
        key_id: key.id,
      }),
    );
    if (action === 'create') changes++;
    config = await providerRequest(() =>
      client.get('llm_analytics/evaluation_config/'),
    );
  }
  if (!dryRun && activeKeyId(config) !== key.id)
    throw new Error('Managed OpenRouter key is not active after setup');
  // Explicit allowlist: never return API objects, masks, errors, or credentials.
  return {
    dryRun,
    action,
    changes,
    name: providerKeyName,
    provider: 'openrouter',
    id: key?.id ?? null,
    state: key?.state ?? 'planned',
    active: Boolean(key && activeKeyId(config) === key.id),
  };
}

main(import.meta, async () => {
  console.log(
    JSON.stringify(
      await applyProvider(liveClient(), parseMode(process.argv.slice(2))),
      null,
      2,
    ),
  );
});
