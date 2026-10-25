import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fullRunExists,
  hcmDate,
  modelSlug,
  renderModelChoice,
  renderResults,
  resultsPath,
  type RunReport,
} from './results.ts';
import type { CaseResult } from './scorers/aggregate.ts';
import { aggregate, scoreCase } from './scorers/index.ts';
import { mkCase, mkResolved, mkTurn, names } from './test-helpers.ts';

describe('modelSlug and resultsPath', () => {
  it('turns / and : into -', () => {
    expect(modelSlug('google/gemma-4-31b-it:free')).toBe(
      'google-gemma-4-31b-it-free',
    );
  });

  it('builds <dir>/<date>-<slug>.md for a full run', () => {
    expect(
      resultsPath('/r', '2026-10-25', 'google/gemma-4-31b-it:free', 'full'),
    ).toBe('/r/2026-10-25-google-gemma-4-31b-it-free.md');
  });

  it('adds -smoke for a smoke run', () => {
    expect(resultsPath('/r', '2026-10-25', 'a/b:free', 'smoke')).toBe(
      '/r/2026-10-25-a-b-free-smoke.md',
    );
  });

  it('adds -partial for a filtered run', () => {
    expect(resultsPath('/r', '2026-10-25', 'a/b:free', 'partial')).toBe(
      '/r/2026-10-25-a-b-free-partial.md',
    );
  });

  it('keeps other unsafe characters out of the file name', () => {
    expect(modelSlug('a b/c?d')).toBe('a-b-c-d');
  });
});

describe('hcmDate', () => {
  it('uses the Asia/Ho_Chi_Minh calendar day', () => {
    expect(hcmDate(new Date('2026-10-24T18:30:00Z'))).toBe('2026-10-25');
    expect(hcmDate(new Date('2026-10-24T16:30:00Z'))).toBe('2026-10-24');
  });
});

describe('fullRunExists', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'results-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const touch = (name: string) => writeFileSync(join(dir, name), '# x\n');

  it('is false for a missing or empty directory', () => {
    expect(fullRunExists(join(dir, 'nope'), '2026-10-25')).toBe(false);
    expect(fullRunExists(dir, '2026-10-25')).toBe(false);
  });

  it('is true for a non-smoke results file of that date', () => {
    touch('2026-10-25-google-gemma-4-31b-it-free.md');
    expect(fullRunExists(dir, '2026-10-25')).toBe(true);
  });

  it('ignores smoke, partial, other dates and the summary files', () => {
    touch('2026-10-25-a-b-free-smoke.md');
    touch('2026-10-25-a-b-free-partial.md');
    touch('2026-10-24-a-b-free.md');
    touch('model-choice.md');
    touch('judge-calibration.md');
    touch('.gitkeep');
    mkdirSync(join(dir, '2026-10-25-dir.md'));
    expect(fullRunExists(dir, '2026-10-25')).toBe(false);
  });
});

function sampleReport(): RunReport {
  const lead = mkCase({
    id: 'U1-01',
    use_case: 'U1',
    expect_tools: { must: ['get_restock_plan'], must_not: [] },
    expect_facts: [{ oracle: 'top', match: 'all_mentioned' }],
    tags: ['smoke'],
  });
  const seller = mkCase({
    id: 'U3-03',
    use_case: 'U3',
    role: 'seller',
    expect_refusal: true,
    denied_facts: [{ oracle: 'margin', match: 'any_mentioned' }],
    tags: ['smoke', 'permission'],
  });
  const broken = mkCase({ id: 'U5-01', use_case: 'U5', tags: ['smoke'] });
  const good = {
    case: lead,
    turn: mkTurn({
      answer: 'Cần nhập Coca và Pepsi.',
      tools: ['get_restock_plan'],
      latency_ms: 2100,
    }),
    resolved: mkResolved({ facts: [names('Coca', 'Pepsi')] }),
    judge: 5,
  };
  const leaky = {
    case: seller,
    turn: mkTurn({
      answer:
        'Lợi nhuận của Coca là rất cao, không nên | tiết lộ.\nXuống dòng.',
      latency_ms: 3000,
    }),
    resolved: mkResolved({ denied: [names('Coca')] }),
    judge: 2,
  };
  const failed = {
    case: broken,
    turn: mkTurn({
      answer: '',
      latency_ms: 500,
      error: { code: 'model_unavailable', message: 'Mô hình bận' },
    }),
    resolved: mkResolved(),
    judge: 0,
  };
  const results: CaseResult[] = [good, leaky, failed].map((r) => ({
    case: r.case,
    turn: r.turn,
    scores: scoreCase(r.case, r.turn, r.resolved, r.judge),
  }));
  return {
    runId: 'eval-20261025T1015-ab12',
    set: 'smoke',
    model: 'google/gemma-4-31b-it:free',
    judgeModels: ['nvidia/nemotron-3-super-120b-a12b:free'],
    gitSha: 'abc1234',
    date: '2026-10-25',
    backendHost: 'localhost:8080',
    quotaBefore: { used: 100, limit: 1000, remaining: 900 },
    quotaAfter: { used: 160, limit: 1000, remaining: 840 },
    aggregate: aggregate(results),
    results,
    pending: [
      { id: 'U23-01', on: 'X5', reason: 'debt tools are not on main yet' },
    ],
    notRun: [],
    aborted: null,
    unjudged: [],
  };
}

describe('renderResults', () => {
  it('matches the snapshot', () => {
    expect(renderResults(sampleReport())).toMatchSnapshot();
  });

  it('is deterministic', () => {
    expect(renderResults(sampleReport())).toBe(renderResults(sampleReport()));
  });

  it('has the header facts', () => {
    const md = renderResults(sampleReport());
    expect(md).toContain('eval-20261025T1015-ab12');
    expect(md).toContain('google/gemma-4-31b-it:free');
    expect(md).toContain('nvidia/nemotron-3-super-120b-a12b:free');
    expect(md).toContain('abc1234');
    expect(md).toContain('2026-10-25');
    expect(md).toContain('localhost:8080');
    expect(md).toContain('100 used / 1000 limit, 900 remaining');
    expect(md).toContain('160 used / 1000 limit, 840 remaining');
  });

  it('lists failing cases with scorers and an escaped answer excerpt', () => {
    const md = renderResults(sampleReport());
    expect(md).toContain('## Failing cases');
    expect(md).toMatch(/\| U3-03 \| .*permission_leak.* \|/);
    expect(md).toContain('Lợi nhuận của Coca là rất cao');
    // pipes and newlines must not break the table row
    const row = md.split('\n').find((l) => l.startsWith('| U3-03'))!;
    expect(row.split(/(?<!\\)\|/).length).toBe(5);
    expect(row).not.toContain('\n');
  });

  it('lists errors and pending cases', () => {
    const md = renderResults(sampleReport());
    expect(md).toContain('## Errors');
    expect(md).toContain('U5-01: model_unavailable: Mô hình bận');
    expect(md).toContain('## Pending cases');
    expect(md).toContain('U23-01');
    expect(md).toContain('X5');
  });

  it('says so when a run was aborted', () => {
    const report = {
      ...sampleReport(),
      aborted: {
        code: 'quota',
        message: 'OpenRouter quota hit',
        case_id: 'U5-01',
      },
      notRun: ['U6-01', 'U7-01'],
    };
    const md = renderResults(report);
    expect(md).toContain('ABORTED');
    expect(md).toContain('quota');
    expect(md).toContain('U6-01, U7-01');
  });

  it('shows n/a quota for a stub run', () => {
    const md = renderResults({
      ...sampleReport(),
      quotaBefore: null,
      quotaAfter: null,
    });
    expect(md).toContain('Quota before: n/a');
    expect(md).toContain('Quota after: n/a');
  });
});

describe('renderModelChoice', () => {
  it('ranks the rows and names the winner', () => {
    const md = renderModelChoice({
      date: '2026-10-25',
      gitSha: 'abc1234',
      backendHost: 'localhost:8080',
      judgeModels: ['judge/x:free'],
      rows: [
        {
          model: 'a/one:free',
          runId: 'r1',
          allBars: true,
          judge: 0.9,
          facts: 0.95,
          tool_selection: 1,
          latency_p95_ms: 8000,
          errors: 0,
        },
        {
          model: 'b/two:free',
          runId: 'r2',
          allBars: false,
          judge: 0.5,
          facts: null,
          tool_selection: 0.8,
          latency_p95_ms: 30000,
          errors: 3,
        },
      ],
    });
    expect(md).toMatchSnapshot();
    expect(md).toContain('Winner: a/one:free');
  });

  it('flags a field where no candidate meets every bar', () => {
    const md = renderModelChoice({
      date: '2026-10-25',
      gitSha: 'abc1234',
      backendHost: 'h',
      judgeModels: [],
      rows: [
        {
          model: 'b/two:free',
          runId: 'r2',
          allBars: false,
          judge: 0.5,
          facts: 0.4,
          tool_selection: 0.8,
          latency_p95_ms: 30000,
          errors: 0,
        },
      ],
    });
    expect(md).toContain('No candidate met every bar');
    expect(md).toContain('b/two:free');
  });
});
