import type { GoldenCase } from '../types.ts';

/**
 * 1 when every `must` tool and one tool from each `any_of` group was called
 * and no `must_not` tool was called. An empty `any_of` group needs nothing.
 */
export function scoreToolSelection(
  called: string[],
  expect: GoldenCase['expect_tools'],
): 0 | 1 {
  const seen = new Set(called);
  if (!expect.must.every((t) => seen.has(t))) return 0;
  if (expect.must_not.some((t) => seen.has(t))) return 0;
  for (const group of expect.any_of ?? []) {
    if (group.length > 0 && !group.some((t) => seen.has(t))) return 0;
  }
  return 1;
}
