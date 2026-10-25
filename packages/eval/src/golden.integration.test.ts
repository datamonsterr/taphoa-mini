import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGolden } from './cases/load.ts';
import { createLiveOracle, type LiveOracle } from './oracle/live.ts';
import { resolveCase } from './oracle/provider.ts';

const databaseUrl = process.env.EVAL_DATABASE_URL;
const dir = fileURLToPath(new URL('../golden', import.meta.url));
const { cases } = loadGolden(dir);
const live = cases.filter((c) => !c.pending);

describe.skipIf(!databaseUrl)('golden cases against the seeded store', () => {
  let oracle: LiveOracle;

  beforeAll(async () => {
    oracle = await createLiveOracle(process.env);
  });
  afterAll(async () => {
    await oracle?.close();
  });

  it('has live cases to resolve', () => {
    expect(live.length).toBeGreaterThan(100);
  });

  it.each(live.map((c) => [c.id, c] as const))(
    '%s resolves through the live oracle',
    async (_id, c) => {
      const resolved = await resolveCase(c, oracle);

      expect(resolved.facts).toHaveLength(c.expect_facts.length);
      for (const value of resolved.facts) {
        expect(value.values.length).toBeGreaterThan(0);
      }
      expect(resolved.denied).toHaveLength((c.denied_facts ?? []).length);
      for (const value of resolved.denied) {
        expect(value.values.length).toBeGreaterThan(0);
      }

      const refs = Object.values(c.expect_action?.fields ?? {}).flatMap((f) =>
        'ref' in f ? [f.ref] : [],
      );
      if (c.context?.receipt) refs.push(c.context.receipt);
      for (const ref of new Set(refs)) {
        expect(resolved.refs[ref] ?? (await oracle.resolveRef(ref))).toMatch(
          /^[0-9a-f-]{36}$/i,
        );
      }
    },
  );

  it('keeps a set-valued fact within what a one-message answer can state', () => {
    // `all_mentioned` on a large name set makes a case unfair; keep it small.
    // Checked here against live values, not by the case author's eye.
    return Promise.all(
      live.flatMap((c) =>
        c.expect_facts
          .filter((f) => f.match === 'all_mentioned')
          .map(async (f) => {
            const value = await oracle.value(f);
            expect(
              value.values.length,
              `${c.id} ${f.oracle}`,
            ).toBeLessThanOrEqual(3);
          }),
      ),
    );
  });
});
