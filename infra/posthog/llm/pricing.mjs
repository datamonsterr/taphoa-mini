import { pathToFileURL } from 'node:url';
import { createClient } from '../lib/client.mjs';
import { loadSecrets } from '../lib/secrets.mjs';

export const assistantModels = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
];
// Also cover the older fallback in both .env.example files and backend config.
export const legacyModels = ['nvidia/nemotron-3-super-120b-a12b:free'];
export const catalogUrl = 'https://openrouter.ai/api/v1/models';

export function configuredModels(env = process.env) {
  const models =
    env.ASSISTANT_MODELS === undefined
      ? [...assistantModels, ...legacyModels]
      : env.ASSISTANT_MODELS.split(',')
          .map((id) => id.trim())
          .filter(Boolean);
  if (!models.length || models.some((id) => !/^[\w.-]+\/[\w.:-]+$/.test(id)))
    throw new Error(
      'ASSISTANT_MODELS must contain OpenRouter model identifiers',
    );
  return [...new Set(models)];
}

export function modelPrices(models, catalog) {
  if (!Array.isArray(catalog?.data))
    throw new Error('Invalid OpenRouter catalog');
  const rate = (value) => {
    if (
      typeof value !== 'string' ||
      !/^\d+(\.\d+)?(e-?\d+)?$/i.test(value) ||
      !Number.isFinite(Number(value))
    )
      throw new Error('Invalid OpenRouter USD per-token price');
    return Number(value);
  };
  return models.map((model) => {
    const found = catalog.data.filter((entry) => entry.id === model);
    if (found.length > 1) throw new Error(`Ambiguous catalog model: ${model}`);
    const pricing = found[0]?.pricing;
    const free = model.endsWith(':free');
    if (!pricing && !free)
      throw new Error(`Paid model missing from OpenRouter: ${model}`);
    const input = pricing ? rate(pricing.prompt) : 0;
    const output = pricing ? rate(pricing.completion) : 0;
    if (free && (input !== 0 || output !== 0))
      throw new Error(`Nonzero :free price: ${model}`);
    // Don't silently present a token-only formula as complete for other charges.
    if (
      pricing &&
      Object.entries(pricing).some(
        ([key, value]) =>
          !['prompt', 'completion'].includes(key) && rate(value) !== 0,
      )
    )
      throw new Error(`Additional pricing components require review: ${model}`);
    return {
      model,
      provider: 'openrouter',
      input,
      output,
      source: pricing
        ? catalogUrl
        : 'explicit :free policy; absent from current catalog',
      event_properties: {
        $ai_input_token_price: input,
        $ai_output_token_price: output,
      },
    };
  });
}

export async function fetchPrices(
  models = configuredModels(),
  fetchImpl = fetch,
) {
  const response = await fetchImpl(catalogUrl, {
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`OpenRouter catalog failed (${response.status})`);
  return modelPrices(models, await response.json());
}

export function liveClient() {
  return createClient({
    ...loadSecrets(),
    fetch: (url, options) =>
      fetch(url, { ...options, signal: AbortSignal.timeout(45000) }),
  });
}

export function parseMode(args) {
  if (
    args.some((arg) => !['--apply', '--dry-run'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--dry-run'))
  )
    throw new Error('Use --dry-run (default) or --apply');
  return { dryRun: !args.includes('--apply') };
}

export function main(meta, run) {
  if (process.argv[1] && pathToFileURL(process.argv[1]).href === meta.url)
    run().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

export async function hogql(client, query) {
  const result = await client.post('query/', {
    query: { kind: 'HogQLQuery', query },
    refresh: 'force_blocking',
  });
  if (!Array.isArray(result.results) || result.error || result.hasMore)
    throw new Error('HogQL did not return a complete synchronous result');
  return result.results;
}

export const sqlString = (value) =>
  `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
