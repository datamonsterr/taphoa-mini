import { fetchPrices, main, parseMode } from './pricing.mjs';

export async function applyPricing({
  dryRun = true,
  prices = fetchPrices,
} = {}) {
  return {
    dryRun,
    changes: 0,
    status: 'event_properties_required',
    reason:
      'PostHog documents per-event custom pricing; no public project pricing CRUD API.',
    models: await prices(),
  };
}

main(import.meta, async () =>
  console.log(
    JSON.stringify(
      await applyPricing(parseMode(process.argv.slice(2))),
      null,
      2,
    ),
  ),
);
