import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCase } from '../cases/validate.ts';
import type { GoldenCase } from '../types.ts';

/** The dry-run cases, used when `golden/` holds no valid cases yet. */
export const FIXTURE_FILE = resolve(
  import.meta.dirname,
  'fixtures',
  'cases.jsonl',
);

/**
 * Read a single JSONL file of cases. Each case goes through `validateCase`,
 * but the one-file-per-use-case rule of `loadGolden` does not apply.
 */
export function loadFixtureCases(file: string = FIXTURE_FILE): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const problems: string[] = [];
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (text.trim() === '') return;
      const where = `${file}:${index + 1}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        problems.push(`${where}: invalid JSON: ${(e as Error).message}`);
        return;
      }
      const errors = validateCase(parsed, where);
      if (errors.length > 0) problems.push(...errors);
      else cases.push(parsed as GoldenCase);
    });
  if (problems.length > 0) {
    throw new Error(`invalid fixture cases:\n${problems.join('\n')}`);
  }
  return cases;
}
