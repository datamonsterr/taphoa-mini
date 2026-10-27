export type UseCase = `U${number}` | 'OT';
export type Role = 'lead' | 'seller';
export type FactMatch =
  'all_mentioned' | 'any_mentioned' | 'number' | 'none_mentioned';
export type Fact = {
  oracle: string;
  args?: Record<string, string | number>;
  match: FactMatch;
  tolerance_pct?: number;
};
export type FieldExpect =
  | { ref: string } // "product:<exact name>", "receipt:<fixture key>", "member:<name>"
  | { eq: string | number | boolean }
  | { min?: number; max?: number }
  | { oracle: string; args?: Record<string, string | number> };
export type GoldenCase = {
  id: string; // "U1-03", "OT-02"
  use_case: UseCase;
  role: Role;
  language?: 'vi' | 'en'; // default 'vi'
  kind?: 'chat' | 'digest'; // default 'chat'
  context?: { screen?: string; receipt?: string };
  messages: { role: 'user'; content: string }[];
  expect_tools: { must: string[]; must_not: string[]; any_of?: string[][] };
  expect_facts: Fact[];
  expect_action: null | { kind: string; fields: Record<string, FieldExpect> };
  expect_refusal?: boolean;
  denied_facts?: Fact[];
  injection?: { canaries: string[]; must_not_tools: string[] };
  rubric_vi: string;
  tags: string[]; // smoke, permission, injection, ambiguity, offtopic, multi_turn, voice
  pending?: { on: 'X5' | 'X8'; reason: string };
};
export type OracleValue =
  | { kind: 'names'; values: string[] }
  | { kind: 'number' | 'money' | 'percent' | 'count'; values: number[] };
export type ProposedAction = { kind: string; payload: Record<string, unknown> };
export type TurnResult = {
  answer: string; // concatenated message.delta text of the last turn
  tools: string[]; // tool names from tool.started across all turns
  actions: ProposedAction[]; // action.proposed across all turns
  model: string | null; // message.completed.model of the last turn
  latency_ms: number; // per-turn durations: max over turns
  error: { code: string; message: string } | null;
};
export type ScorerName =
  | 'tool_selection'
  | 'facts'
  | 'action'
  | 'permission_leak'
  | 'injection_resisted'
  | 'judge'
  | 'language'
  | 'latency_ms';
export type CaseScore = {
  case_id: string;
  use_case: UseCase;
  scorer: ScorerName;
  value: number;
};
/** Oracle output for one case. `facts` and `denied` align by index with
 * `expect_facts` and `denied_facts`. `actionOracles` keys are
 * `actionOracleKey(oracle, args)`. */
export type ResolvedCase = {
  facts: OracleValue[];
  denied: OracleValue[];
  refs: Record<string, string>;
  actionOracles: Record<string, OracleValue>;
};
