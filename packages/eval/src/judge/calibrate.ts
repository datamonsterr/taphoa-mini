import { readFileSync } from 'node:fs';
import type { JudgeInput, JudgeResult } from './judge.ts';
import { DEFAULT_TODAY } from '../runner/client.ts';

export const AGREEMENT_BAR = 0.9;
export const MAE_BAR = 0.8;
/** A score of this value or more counts as a pass, for judge and human alike. */
const PASS_SCORE = 4;
const EPSILON = 1e-9;

export type CalibrationItem = JudgeInput & {
  /** The hand-given score, 1-5. */
  human_score: number;
};
export type CalibrationRow = {
  human: number;
  /** null when the judge gave no usable score. */
  judge: number | null;
  /** |human - judge|; null when unjudged. */
  error: number | null;
  /** Both sides on the same side of the pass line (4). */
  agree: boolean;
  reason: string;
};
export type CalibrationResult = {
  agreement: number;
  mae: number;
  pass: boolean;
  rows: CalibrationRow[];
};

/**
 * Compare the judge with hand-labelled answers. `agreement` is the share of
 * items where judge >= 4 equals human >= 4. `mae` is the mean absolute error
 * over the judged items. An unjudged item counts as a disagreement and stops
 * the check from passing. It passes at agreement >= 0.9 and MAE <= 0.8.
 */
export async function calibrate(
  items: CalibrationItem[],
  judge: (input: JudgeInput) => Promise<JudgeResult | null>,
): Promise<CalibrationResult> {
  const rows: CalibrationRow[] = [];
  for (const item of items) {
    const verdict = await judge({
      rubric_vi: item.rubric_vi,
      answer: item.answer,
      messages: item.messages ?? [],
      fixture_context: item.fixture_context ?? {
        business_date: DEFAULT_TODAY,
        timezone: 'Asia/Ho_Chi_Minh',
      },
    });
    rows.push(
      verdict
        ? {
            human: item.human_score,
            judge: verdict.score,
            error: Math.abs(item.human_score - verdict.score),
            agree:
              verdict.score >= PASS_SCORE === item.human_score >= PASS_SCORE,
            reason: verdict.reason,
          }
        : {
            human: item.human_score,
            judge: null,
            error: null,
            agree: false,
            reason: '',
          },
    );
  }
  const judged = rows.filter((r) => r.error !== null);
  const agreement =
    rows.length === 0 ? 0 : rows.filter((r) => r.agree).length / rows.length;
  const mae =
    judged.length === 0
      ? 0
      : judged.reduce((sum, r) => sum + r.error!, 0) / judged.length;
  const pass =
    rows.length > 0 &&
    judged.length === rows.length &&
    agreement >= AGREEMENT_BAR - EPSILON &&
    mae <= MAE_BAR + EPSILON;
  return { agreement, mae, pass, rows };
}

/** Read `{rubric_vi, answer, human_score}` lines; errors carry `file:line`. */
export function loadCalibrationItems(file: string): CalibrationItem[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `cannot read calibration file ${file}: ${(e as Error).message}`,
    );
  }
  const items: CalibrationItem[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const where = `${file}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`${where}: invalid JSON: ${(e as Error).message}`);
    }
    const o = parsed as Partial<CalibrationItem> | null;
    const score = o?.human_score;
    if (
      typeof o?.rubric_vi !== 'string' ||
      o.rubric_vi.trim() === '' ||
      typeof o.answer !== 'string' ||
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < 1 ||
      score > 5
    ) {
      throw new Error(
        `${where}: need {rubric_vi: string, answer: string, human_score: integer 1-5}`,
      );
    }
    items.push({
      rubric_vi: o.rubric_vi,
      answer: o.answer,
      human_score: score,
    });
  });
  return items;
}

const percent = (x: number) => `${Number((x * 100).toFixed(1))} %`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Markdown for `results/judge-calibration.md`. */
export function renderCalibration(
  result: CalibrationResult,
  meta: { judgeModel: string; date: string },
): string {
  const lines = [
    '# Judge calibration',
    '',
    `- Date: ${meta.date}`,
    `- Judge model: ${meta.judgeModel}`,
    '- Input format: rubric, user messages, fixture context, answer (same serializer as live eval). Original calibration items have no user messages or SQL facts; context supplies only the pinned business date and timezone.',
    `- Items: ${result.rows.length}`,
    `- Agreement: ${percent(result.agreement)} (bar: ≥ 90 %)`,
    `- MAE: ${Number(result.mae.toFixed(2))} (bar: ≤ 0.8)`,
    `- Verdict: ${result.pass ? 'PASS' : 'FAIL'}`,
    '',
    '| # | Human | Judge | Error | Agree | Reason |',
    '| - | ----- | ----- | ----- | ----- | ------ |',
    ...result.rows.map(
      (r, i) =>
        `| ${i + 1} | ${r.human} | ${r.judge ?? 'none'} | ${r.error ?? 'n/a'} | ${r.agree ? 'yes' : 'no'} | ${cell(r.reason)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
