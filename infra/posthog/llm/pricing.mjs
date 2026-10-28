import { pathToFileURL } from 'node:url';
import { createClient } from '../lib/client.mjs';
import { loadSecrets } from '../lib/secrets.mjs';

export const assistantModels = [
  'z-ai/glm-5.3-flash',
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

export function modelPrices(models, catalog, endpoints = {}) {
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
    // These catalog components are conditional (cache, reasoning or modalities).
    // Verification below is scoped to text generations; unknown fixed charges fail closed.
    const known = [
      'prompt',
      'completion',
      'input_cache_read',
      'input_cache_write',
      'input_cache_write_1h',
      'internal_reasoning',
      'web_search',
      'image',
      'image_output',
      'audio',
      'input_audio_cache',
    ];
    const endpointPrices = (endpoints[model]?.data?.endpoints ?? []).map(
      (e) => e.pricing,
    );
    const tiers = [
      pricing,
      ...(pricing?.overrides ?? []),
      ...endpointPrices,
    ].filter(Boolean);
    for (const tier of tiers)
      for (const [key, value] of Object.entries(tier)) {
        if (
          key === 'overrides' ||
          key === 'min_prompt_tokens' ||
          key === 'discount'
        )
          continue;
        if (!known.includes(key) && rate(value) !== 0)
          throw new Error(
            `Additional pricing components require review: ${model}`,
          );
        rate(value);
      }
    const inputs = tiers.flatMap((t) =>
      [
        'prompt',
        'input_cache_read',
        'input_cache_write',
        'input_cache_write_1h',
      ]
        .filter((k) => t[k] !== undefined)
        .map((k) => rate(t[k])),
    );
    const outputs = tiers.flatMap((t) =>
      ['completion'].filter((k) => t[k] !== undefined).map((k) => rate(t[k])),
    );
    return {
      model,
      provider: 'openrouter',
      input,
      output,
      inputMin: Math.min(input, ...inputs),
      inputMax: Math.max(input, ...inputs),
      outputMin: Math.min(output, ...outputs),
      outputMax: Math.max(output, ...outputs),
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
  const catalog = await response.json();
  const endpoints = {};
  for (const model of models.filter((m) => !m.endsWith(':free'))) {
    const res = await fetchImpl(`${catalogUrl}/${model}/endpoints`, {
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!res.ok)
      throw new Error(`OpenRouter endpoints failed (${res.status}): ${model}`);
    endpoints[model] = await res.json();
    if (
      !Array.isArray(endpoints[model]?.data?.endpoints) ||
      !endpoints[model].data.endpoints.length
    )
      throw new Error(`OpenRouter endpoints missing: ${model}`);
  }
  return modelPrices(models, catalog, endpoints);
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
