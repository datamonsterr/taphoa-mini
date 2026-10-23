// Starts a Prism mock of docs/api/openapi.yaml, calls it through @taphoa/api-client, stops it.
import { spawn } from 'node:child_process';
import { createApiClient } from '../packages/api-client/src/index.ts';

const port = Number(process.env.MOCK_API_PORT ?? 4010);
const baseUrl = `http://127.0.0.1:${port}`;

const prism = spawn(
  'pnpm',
  [
    'exec',
    'prism',
    'mock',
    'docs/api/openapi.yaml',
    '-p',
    String(port),
    '-h',
    '127.0.0.1',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
prism.stdout.on('data', () => {});

async function waitUntilReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (prism.exitCode !== null) throw new Error('prism exited early');
    try {
      await fetch(`${baseUrl}/healthz`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('prism did not start in time');
}

function assert2xx(name, result) {
  const status = result.response.status;
  if (status < 200 || status >= 300) {
    throw new Error(`${name}: expected 2xx, got ${status}`);
  }
  console.log(`ok ${name} -> ${status}`);
}

let failed = false;
try {
  await waitUntilReady();
  const api = createApiClient({ baseUrl, getToken: () => 'smoke-token' });
  assert2xx('GET /healthz', await api.getHealth());
  assert2xx(
    'GET /v1/images/{imageId}',
    await api.getImage('0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b'),
  );
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  prism.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
