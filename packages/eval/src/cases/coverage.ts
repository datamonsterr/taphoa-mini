import type { GoldenCase } from '../types.ts';

export const MIN_PER_USE_CASE = 6;
export const MIN_OFF_TOPIC = 6;
export const MIN_TAG_COUNTS: Record<string, number> = {
  permission: 10,
  injection: 8,
  ambiguity: 6,
};
export const SMOKE_COUNT = 25;
export const SMOKE_MIN_USE_CASES = 15;
const USE_CASE_COUNT = 23;

function oraclesOf(c: GoldenCase): string[] {
  const names = [
    ...c.expect_facts.map((f) => f.oracle),
    ...(c.denied_facts ?? []).map((f) => f.oracle),
  ];
  for (const expected of Object.values(c.expect_action?.fields ?? {})) {
    if ('oracle' in expected) names.push(expected.oracle);
  }
  return names;
}

/**
 * Problems with the case set as a whole: too few cases per use case, tag
 * counts under the minimum, the smoke set's size and spread, and (when
 * `knownOracles` is given) oracle names nobody defines. Pending cases count.
 */
export function checkCoverage(
  cases: GoldenCase[],
  knownOracles?: Set<string>,
): string[] {
  const problems: string[] = [];

  const perUseCase = new Map<string, number>();
  for (const c of cases) {
    perUseCase.set(c.use_case, (perUseCase.get(c.use_case) ?? 0) + 1);
  }
  const useCases = [
    ...Array.from({ length: USE_CASE_COUNT }, (_, i) => `U${i + 1}`),
    'OT',
  ];
  for (const use_case of useCases) {
    const n = perUseCase.get(use_case) ?? 0;
    const min = use_case === 'OT' ? MIN_OFF_TOPIC : MIN_PER_USE_CASE;
    if (n < min) problems.push(`${use_case}: ${n} cases, need at least ${min}`);
  }

  for (const [tag, min] of Object.entries(MIN_TAG_COUNTS)) {
    const n = cases.filter((c) => c.tags.includes(tag)).length;
    if (n < min) problems.push(`tag ${tag}: ${n} cases, need at least ${min}`);
  }

  const smoke = cases.filter((c) => c.tags.includes('smoke'));
  if (smoke.length !== SMOKE_COUNT) {
    problems.push(`smoke: ${smoke.length} cases, need exactly ${SMOKE_COUNT}`);
  }
  const smokeUseCases = new Set(smoke.map((c) => c.use_case)).size;
  if (smokeUseCases < SMOKE_MIN_USE_CASES) {
    problems.push(
      `smoke: spread over ${smokeUseCases} use cases, need at least ${SMOKE_MIN_USE_CASES}`,
    );
  }

  if (knownOracles) {
    const usedBy = new Map<string, string[]>();
    for (const c of cases) {
      for (const name of new Set(oraclesOf(c))) {
        if (knownOracles.has(name)) continue;
        usedBy.set(name, [...(usedBy.get(name) ?? []), c.id]);
      }
    }
    for (const [name, ids] of usedBy) {
      problems.push(`unknown oracle '${name}' used by ${ids.join(', ')}`);
    }
  }
  return problems;
}
