import type {
  GoldenCase,
  OracleValue,
  ResolvedCase,
  TurnResult,
  UseCase,
} from './types.ts';

/** A valid chat case; tests override only what they exercise. */
export function mkCase(over: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: 'U1-01',
    use_case: 'U1',
    role: 'lead',
    messages: [{ role: 'user', content: 'Tuần tới cần nhập thêm gì?' }],
    expect_tools: { must: [], must_not: [] },
    expect_facts: [],
    expect_action: null,
    rubric_vi: 'Trả lời ngắn, đúng số liệu.',
    tags: [],
    ...over,
  };
}

export function mkTurn(over: Partial<TurnResult> = {}): TurnResult {
  return {
    answer: 'Xin chào, cửa hàng của bạn có 24 chai Coca.',
    tools: [],
    actions: [],
    model: 'test/model',
    latency_ms: 1000,
    error: null,
    ...over,
  };
}

export function mkResolved(over: Partial<ResolvedCase> = {}): ResolvedCase {
  return { facts: [], denied: [], refs: {}, actionOracles: {}, ...over };
}

export function names(...values: string[]): OracleValue {
  return { kind: 'names', values };
}

export function money(...values: number[]): OracleValue {
  return { kind: 'money', values };
}

export function count(...values: number[]): OracleValue {
  return { kind: 'count', values };
}

export function percent(...values: number[]): OracleValue {
  return { kind: 'percent', values };
}

/** 144 cases that meet every coverage rule exactly. */
export function mkFullSet(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (let u = 1; u <= 23; u++) {
    for (let n = 1; n <= 6; n++) {
      const tags: string[] = [];
      const extra: Partial<GoldenCase> = {};
      if (n === 1 && u <= 15) tags.push('smoke');
      if (n === 2 && u <= 10) tags.push('smoke');
      if (n === 3 && u <= 10) {
        tags.push('permission');
        extra.role = 'seller';
        extra.expect_refusal = true;
      }
      if (n === 3 && u >= 11 && u <= 18) {
        tags.push('injection');
        extra.injection = { canaries: ['PWNED'], must_not_tools: [] };
      }
      if (n === 4 && u <= 6) tags.push('ambiguity');
      cases.push(
        mkCase({
          id: `U${u}-0${n}`,
          use_case: `U${u}` as UseCase,
          tags,
          ...extra,
        }),
      );
    }
  }
  for (let n = 1; n <= 6; n++) {
    cases.push(mkCase({ id: `OT-0${n}`, use_case: 'OT', tags: ['offtopic'] }));
  }
  return cases;
}
