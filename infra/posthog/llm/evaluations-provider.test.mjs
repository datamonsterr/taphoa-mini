import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProvider, loadJudgeKey } from './evaluations-provider.mjs';
import { providerKeyName } from './evaluations.mjs';

const credential = 'fake-private-judge-credential';
const healthy = {
  id: 'key-id',
  name: providerKeyName,
  provider: 'openrouter',
  state: 'ok',
};
function fixture({ keys = [], active = null } = {}) {
  const writes = [];
  const client = {
    listAll: async () => keys,
    get: async () => ({ active_provider_key: active }),
    post: async (path, body) => {
      writes.push({ path, body });
      if (path === 'llm_analytics/provider_keys/') {
        const key = {
          ...healthy,
          api_key_masked: 'partial-private',
          error_message: credential,
        };
        keys.push(key);
        if (body.set_as_active) active = key;
        return key;
      }
      assert.equal(path, 'llm_analytics/evaluation_config/set_active_key/');
      assert.deepEqual(body, { key_id: healthy.id });
      active = healthy.id;
      return { active_provider_key: active };
    },
  };
  return { client, writes };
}

test('provider setup defaults to dry-run without loading or sending a credential', async () => {
  const f = fixture();
  const result = await applyProvider(f.client, {
    readKey: () => {
      throw new Error('must not read');
    },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'create');
  assert.equal(f.writes.length, 0);
});

test('provider apply creates once, activates, and returns only safe metadata on rerun', async () => {
  const f = fixture();
  const first = await applyProvider(f.client, {
    dryRun: false,
    readKey: () => credential,
  });
  assert.equal(first.action, 'create');
  assert.equal(first.active, true);
  assert.deepEqual(f.writes[0], {
    path: 'llm_analytics/provider_keys/',
    body: {
      name: providerKeyName,
      provider: 'openrouter',
      api_key: credential,
      set_as_active: true,
    },
  });
  const second = await applyProvider(f.client, {
    dryRun: false,
    readKey: () => {
      throw new Error('must not reread');
    },
  });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.changes, 0);
  assert.equal(f.writes.length, 1);
  assert.ok(!JSON.stringify([first, second]).includes(credential));
  assert.ok(!JSON.stringify([first, second]).includes('partial-private'));
});

test('existing inactive healthy key is activated without a credential write', async () => {
  const f = fixture({ keys: [healthy] });
  assert.equal((await applyProvider(f.client)).action, 'activate');
  assert.equal(f.writes.length, 0);
  const result = await applyProvider(f.client, { dryRun: false });
  assert.equal(result.active, true);
  assert.equal(f.writes.length, 1);
});

test('ambiguous, unhealthy and wrong-provider names fail without overwriting keys', async () => {
  for (const keys of [
    [healthy, healthy],
    [{ ...healthy, state: 'error' }],
    [{ ...healthy, provider: 'openai' }],
  ]) {
    const f = fixture({ keys });
    await assert.rejects(
      applyProvider(f.client, { dryRun: false }),
      /Ambiguous|healthy OpenRouter/,
    );
    assert.equal(f.writes.length, 0);
  }
});

test('provider errors redact full and partial credentials in all request paths', async () => {
  for (const operation of ['listAll', 'get', 'post']) {
    const f = fixture();
    f.client[operation] = async () => {
      throw new Error(`api_key=${credential}; partial-private`);
    };
    await assert.rejects(
      applyProvider(f.client, { dryRun: false, readKey: () => credential }),
      (error) => {
        assert.match(error.message, /\[REDACTED\]/);
        assert.ok(!error.message.includes(credential));
        assert.ok(!error.message.includes('partial-private'));
        return true;
      },
    );
  }
});

test('runtime key loader reads a private secrets file, honors environment and fails safely', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'i63-judge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'secrets.env');
  writeFileSync(
    path,
    `UNRELATED=ignored\nOPENROUTER_POSTHOG_JUDGE_KEY='${credential}'\n`,
    { mode: 0o600 },
  );
  assert.equal(loadJudgeKey({ path, env: {} }), credential);
  assert.equal(
    loadJudgeKey({ path, env: { OPENROUTER_POSTHOG_JUDGE_KEY: 'override' } }),
    'override',
  );
  chmodSync(path, 0o644);
  assert.throws(() => loadJudgeKey({ path, env: {} }), /mode 600/);
  assert.throws(
    () => loadJudgeKey({ path, env: { OPENROUTER_POSTHOG_JUDGE_KEY: '' } }),
    /Missing required key: OPENROUTER_POSTHOG_JUDGE_KEY/,
  );
});
