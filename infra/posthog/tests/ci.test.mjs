import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('CI selects posthog infra, tests offline on Node 24, and gates ci-ok', () => {
  const yaml = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    yaml,
    /posthog-infra: \$\{\{ steps.filter.outputs.posthog-infra \}\}/,
  );
  assert.match(
    yaml,
    /posthog-infra:\n\s+- 'infra\/posthog\/\*\*'\n\s+- '.github\/workflows\/ci.yml'/,
  );
  const job =
    yaml.match(/^  posthog-infra:\n([\s\S]*?)(?=^  [a-z][\w-]*:)/m)?.[1] ?? '';
  assert.match(job, /actions\/checkout@v7/);
  assert.match(job, /actions\/setup-node@v7/);
  assert.match(job, /node-version-file: .nvmrc/);
  assert.match(job, /node --test infra\/posthog\/tests/);
  assert.match(job, /node infra\/posthog\/apply.mjs --dry-run --offline/);
  assert.match(job, /scripts\/ci\/job-summary.sh/);
  assert.match(yaml.split('  ci-ok:')[1], /- posthog-infra/);
});
