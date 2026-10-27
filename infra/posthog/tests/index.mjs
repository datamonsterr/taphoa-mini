// Node 24 resolves an explicit directory through package.json, unlike Node 26's
// directory discovery. Keep the required `node --test infra/posthog/tests` portable.
import { readdirSync } from 'node:fs';
for (const file of readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()) {
  await import(new URL(file, import.meta.url));
}
