import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runtime secrets use environment precedence without revealing missing values', async () => {
  const { loadSecrets } = await import('../lib/secrets.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'posthog-secrets-'));
  const path = join(dir, 'secrets.env');
  try {
    writeFileSync(
      path,
      '# local credentials\nPOSTHOG_PERSONAL_API_KEY=file-key\nPOSTHOG_PROJECT_ID=42\n',
      { mode: 0o600 },
    );
    assert.deepEqual(
      loadSecrets({ path, env: { POSTHOG_PERSONAL_API_KEY: 'override-key' } }),
      {
        apiKey: 'override-key',
        projectId: '42',
        host: 'https://us.posthog.com',
      },
    );
    assert.throws(
      () => loadSecrets({ path: join(dir, 'missing'), env: {} }),
      /Missing required key: POSTHOG_PERSONAL_API_KEY/,
    );
    assert.throws(
      () =>
        loadSecrets({
          path: join(dir, 'missing'),
          env: { POSTHOG_PERSONAL_API_KEY: 'do-not-print' },
        }),
      /Missing required key: POSTHOG_PROJECT_ID/,
    );
    assert.equal(
      loadSecrets({ path, env: { POSTHOG_API_HOST: 'https://example.test/' } })
        .host,
      'https://example.test',
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
