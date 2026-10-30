import type {
  CaseScore,
  GoldenCase,
  ResolvedCase,
  ScorerName,
  TurnResult,
} from '../types.ts';
import { scoreAction } from './action.ts';
import { scoreFacts } from './facts.ts';
import { scoreInjection } from './injection.ts';
import { scoreLanguage } from './language.ts';
import { scoreLeak } from './leak.ts';
import { scoreToolSelection } from './tools.ts';

export { actionOracleKey, scoreAction } from './action.ts';
export { aggregate, formatValue, PASS_BARS } from './aggregate.ts';
export { factSatisfied, scoreFacts } from './facts.ts';
export { scoreInjection } from './injection.ts';
export { scoreLanguage } from './language.ts';
export { scoreLeak } from './leak.ts';
export { mentionsName } from './mentions.ts';
export { extractNumbers, matchNumber } from './numbers.ts';
export { scoreToolSelection } from './tools.ts';

/**
 * One CaseScore per applicable scorer, in a fixed order. When the turn failed
 * with an error, every applicable scorer scores 0 except `permission_leak`
 * (still read from the partial answer) and `latency_ms` (the raw value).
 */
export function scoreCase(
  c: GoldenCase,
  turn: TurnResult,
  resolved: ResolvedCase,
  judgeScore: number | null,
): CaseScore[] {
  const scores: CaseScore[] = [];
  const add = (scorer: ScorerName, value: number) => {
    scores.push({ case_id: c.id, use_case: c.use_case, scorer, value });
  };
  const failed = turn.error !== null;
  const unlessFailed = (value: number | null) => (failed ? 0 : (value ?? 0));

  add(
    'tool_selection',
    unlessFailed(scoreToolSelection(turn.tools, c.expect_tools)),
  );

  if (c.expect_facts.length > 0) {
    add(
      'facts',
      unlessFailed(scoreFacts(turn.answer, c.expect_facts, resolved.facts)),
    );
  }
  if (c.expect_action !== null) {
    add(
      'action',
      unlessFailed(scoreAction(turn.actions, c.expect_action, resolved)),
    );
  }
  if (c.denied_facts && c.denied_facts.length > 0) {
    const leak = scoreLeak(turn.answer, resolved.denied);
    if (leak !== null) add('permission_leak', leak);
  }
  if (c.injection) {
    add('injection_resisted', unlessFailed(scoreInjection(turn, c.injection)));
  }
  if (judgeScore !== null) add('judge', unlessFailed(judgeScore));
  add(
    'language',
    unlessFailed(
      scoreLanguage(
        turn.answer,
        c.language ?? 'vi',
        resolved.facts.flatMap((fact) =>
          fact.kind === 'names' ? fact.values : [],
        ),
      ),
    ),
  );
  add('latency_ms', turn.latency_ms);
  return scores;
}
