import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loadSecrets({
  path = join(homedir(), '.config/taphoa-mini/secrets.env'),
  env = process.env,
} = {}) {
  const values = {};
  try {
    if ((statSync(path).mode & 0o777) !== 0o600)
      throw new Error('Secrets file must have mode 600');
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(error.code ? 'Cannot read secrets file' : error.message);
  }
  const read = (key) => env[key] ?? values[key];
  for (const key of ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID']) {
    if (!read(key)?.trim()) throw new Error(`Missing required key: ${key}`);
  }
  return {
    apiKey: read('POSTHOG_PERSONAL_API_KEY'),
    projectId: read('POSTHOG_PROJECT_ID'),
    host: (read('POSTHOG_API_HOST') || 'https://us.posthog.com').replace(
      /\/+$/,
      '',
    ),
  };
}
