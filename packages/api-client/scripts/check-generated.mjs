// Regenerate the schema into a temp file and fail when it differs from the committed one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'taphoa-schema-'));
const out = join(tmp, 'schema.d.ts');
try {
  execFileSync(
    'pnpm',
    ['exec', 'openapi-typescript', '../../docs/api/openapi.yaml', '-o', out],
    { stdio: 'inherit' },
  );
  const fresh = readFileSync(out, 'utf8');
  const committed = readFileSync('src/schema.d.ts', 'utf8');
  if (fresh !== committed) {
    console.error(
      'src/schema.d.ts is out of date with docs/api/openapi.yaml. Run `pnpm api:generate`.',
    );
    process.exit(1);
  }
  console.log('src/schema.d.ts is up to date.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
