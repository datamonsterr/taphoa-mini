import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoldenCase } from '../types.ts';
import { validateCase } from './validate.ts';

export type LoadResult = { cases: GoldenCase[]; errors: string[] };

/** U1, U2, ..., U23, then every other file name (OT) last. */
function fileRank(name: string): [number, number] {
  const m = /^U(\d+)\.jsonl$/.exec(name);
  return m ? [0, Number(m[1])] : [1, 0];
}

function byFileOrder(a: string, b: string): number {
  const [ga, na] = fileRank(a);
  const [gb, nb] = fileRank(b);
  return ga - gb || na - nb || a.localeCompare(b);
}

/**
 * Read `<dir>/*.jsonl` (one case per line, blank lines skipped). Returns the
 * valid cases and one `file:line: message` error for each JSON error,
 * validation error, duplicate id, or case that sits in the wrong file
 * (`U3.jsonl` holds only U3, `OT.jsonl` only OT). Invalid and duplicate cases
 * are left out of `cases`.
 */
export function loadGolden(dir: string): LoadResult {
  const cases: GoldenCase[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name)
      .sort(byFileOrder);
  } catch (e) {
    errors.push(`${dir}: cannot read directory: ${(e as Error).message}`);
    return { cases, errors };
  }

  const firstSeen = new Map<string, string>();
  for (const name of files) {
    const stem = name.slice(0, -'.jsonl'.length);
    const lines = readFileSync(join(dir, name), 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      if (text.trim() === '') return;
      const where = `${join(dir, name)}:${index + 1}`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        errors.push(`${where}: invalid JSON: ${(e as Error).message}`);
        return;
      }
      const problems = validateCase(parsed, where);
      if (problems.length > 0) {
        errors.push(...problems);
        return;
      }

      const c = parsed as GoldenCase;
      const first = firstSeen.get(c.id);
      if (first !== undefined) {
        errors.push(`${where}: duplicate id ${c.id} (first at ${first})`);
        return;
      }
      firstSeen.set(c.id, where);
      if (c.use_case !== stem) {
        errors.push(
          `${where}: case ${c.id} is ${c.use_case}, but ${name} holds only ${stem}`,
        );
      }
      cases.push(c);
    });
  }
  return { cases, errors };
}
