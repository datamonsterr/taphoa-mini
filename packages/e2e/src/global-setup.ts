import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteUser } from './clerk.js';

export default function setup() {
  if (!process.env.CLERK_SECRET_KEY?.trim()) {
    throw new Error('CLERK_SECRET_KEY is required for live Clerk e2e runs');
  }
  const directory = mkdtempSync(join(tmpdir(), 'taphoa-clerk-e2e-'));
  process.env.CLERK_TRACKING_DIR = directory;
  return async () => {
    const ids = new Set<string>();
    for (const file of readdirSync(directory)) {
      for (const line of readFileSync(join(directory, file), 'utf8')
        .trim()
        .split('\n')) {
        if (line) ids.add(JSON.parse(line) as string);
      }
    }
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await deleteUser(id);
      } catch {
        failures.push(id);
      }
    }
    delete process.env.CLERK_TRACKING_DIR;
    if (failures.length) {
      throw new Error(
        `Clerk cleanup failed for ${failures.length} users; tracking retained at ${directory}. Run clerk:sweep after 24h.`,
      );
    }
    rmSync(directory, { recursive: true });
  };
}
