import {
  AssistantStreamInterruptedError,
  AssistantStreamProtocolError,
  createApiClient,
  type Digest,
} from '@taphoa/api-client';
import { formatMoney, formatNumber } from '../format.ts';
import type { OracleProvider } from '../oracle/provider.ts';
import type { GoldenCase, ProposedAction, TurnResult } from '../types.ts';
import type { AuthProvider } from './auth.ts';

/** The business date the eval store is pinned to. */
export const DEFAULT_TODAY = '2026-10-20';
export const DEFAULT_TURN_TIMEOUT_MS = 90_000;
/** What the backend accepts as `X-Taphoa-Eval-Run`. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `AssistantThreadContext.screen` is required; cases that name only a receipt get this. */
const RECEIPT_SCREEN = 'receipt';
const DEFAULT_SCREEN = 'assistant';

export type TurnOptions = {
  baseUrl: string;
  auth: AuthProvider;
  /** Resolves `context.receipt` to the receipt id. */
  oracle: OracleProvider;
  /** Sent as `X-Taphoa-Eval-Run`: 1-64 characters of `[A-Za-z0-9._:-]`. */
  runId: string;
  /** Business date, sent as `X-Taphoa-Today`. Default 2026-10-20. */
  today?: string;
  /** Sent as `X-Taphoa-Eval-Model`: the backend uses it for this turn, with no fallback. */
  model?: string;
  fetch?: typeof fetch;
  /** Give up on one turn after this long. Default 90 s. */
  turnTimeoutMs?: number;
};

/** Run ids and dates the backend would silently ignore are refused here. */
export function assertEvalHeaders(runId: string, today: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `invalid eval run id ${JSON.stringify(runId)}: use 1-64 characters from [A-Za-z0-9._:-]`,
    );
  }
  if (!DATE_PATTERN.test(today)) {
    throw new Error(
      `invalid date ${JSON.stringify(today)} for X-Taphoa-Today: use YYYY-MM-DD`,
    );
  }
}

/** A fetch that adds auth and eval headers, fresh from the provider, to every request. */
export function withHeaders(
  base: typeof fetch,
  headersFor: () => Promise<Record<string, string>>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    for (const [name, value] of Object.entries(await headersFor())) {
      request.headers.set(name, value);
    }
    return base(request);
  };
}

type TurnError = NonNullable<TurnResult['error']>;

function describeBody(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  return typeof body === 'string' && body !== '' ? body : 'no details';
}

function classify(e: unknown, timedOut: boolean, timeoutMs: number): TurnError {
  if (timedOut) {
    return {
      code: 'timeout',
      message: `no complete reply within ${timeoutMs} ms`,
    };
  }
  if (e instanceof AssistantStreamInterruptedError) {
    return { code: 'stream_interrupted', message: e.message };
  }
  if (e instanceof AssistantStreamProtocolError) {
    return { code: 'stream_protocol', message: e.message };
  }
  const err = e as Error & { cause?: { code?: string } };
  const cause = err.cause?.code ? ` (${err.cause.code})` : '';
  return { code: 'network', message: `${err.message}${cause}` };
}

/** The digest as one block of text: the summary, then the figures the card shows. */
function digestText(d: Digest): string {
  const lines = [d.summary_vi];
  const sales = [
    `Doanh thu: ${formatMoney(d.sales.revenue)}`,
    `Số đơn: ${formatNumber(d.sales.sale_count)}`,
  ];
  if (d.sales.gross_profit !== null) {
    sales.push(`Lợi nhuận gộp: ${formatMoney(d.sales.gross_profit)}`);
  }
  if (d.sales.change_pct !== null) {
    sales.push(`So với hôm trước: ${formatNumber(d.sales.change_pct)}%`);
  }
  lines.push(`${sales.join('; ')}.`);
  if (d.restock.length > 0) {
    lines.push(`Cần nhập: ${d.restock.map((r) => r.name).join(', ')}.`);
  }
  lines.push(
    `Nợ quá hạn: ${formatNumber(d.overdue_debts.count)} khách, ${formatMoney(d.overdue_debts.total)}.`,
    `Phiếu nháp đang mở: ${formatNumber(d.open_drafts.count)}.`,
  );
  return lines.join('\n');
}

/**
 * Play one case against the backend: create a thread (with the case context),
 * send each user message in order, and read every SSE stream. The answer is
 * the last turn's text; tools and actions are collected over all turns; the
 * latency is the slowest turn. A failed turn ends the case with `error` set.
 * A `digest` case reads `GET /v1/assistant/digest` instead.
 */
export async function runTurns(
  opts: TurnOptions,
  c: GoldenCase,
): Promise<TurnResult> {
  const today = opts.today ?? DEFAULT_TODAY;
  assertEvalHeaders(opts.runId, today);
  const timeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

  const api = createApiClient({
    baseUrl: opts.baseUrl,
    fetch: withHeaders(
      opts.fetch ?? ((...args) => globalThis.fetch(...args)),
      async () => ({
        ...(await opts.auth.headersFor(c.role)),
        'X-Taphoa-Today': today,
        'X-Taphoa-Eval-Run': opts.runId,
        ...(opts.model ? { 'X-Taphoa-Eval-Model': opts.model } : {}),
      }),
    ),
  });

  const result: TurnResult = {
    answer: '',
    tools: [],
    actions: [],
    model: null,
    latency_ms: 0,
    error: null,
  };

  /** Run `step` under the turn timeout, turning any failure into `result.error`. */
  async function guarded(
    step: (signal: AbortSignal) => Promise<TurnError | null>,
  ): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      result.error = await step(controller.signal);
    } catch (e) {
      result.error = classify(e, controller.signal.aborted, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
    return performance.now() - started;
  }

  if (c.kind === 'digest') {
    result.latency_ms = await guarded(async (signal) => {
      const res = await api.raw.GET('/v1/assistant/digest', {
        params: { query: { business_date: today } },
        signal,
      });
      if (!res.response.ok || res.data === undefined) {
        return {
          code: `http_${res.response.status}`,
          message: describeBody(res.error),
        };
      }
      result.answer = digestText(res.data);
      return null;
    });
    return result;
  }

  // Creating the thread is not a turn: it does not count toward the latency.
  let threadId = '';
  await guarded(async (signal) => {
    let receiptId: string | undefined;
    if (c.context?.receipt) {
      receiptId = await opts.oracle.resolveRef(c.context.receipt);
    }
    const context = c.context
      ? {
          screen:
            c.context.screen ??
            (c.context.receipt ? RECEIPT_SCREEN : DEFAULT_SCREEN),
          ...(receiptId ? { receipt_id: receiptId } : {}),
        }
      : undefined;
    const res = await api.raw.POST('/v1/assistant/threads', {
      body: context ? { context } : {},
      signal,
    });
    if (!res.response.ok || res.data === undefined) {
      return {
        code: `http_${res.response.status}`,
        message: describeBody(res.error),
      };
    }
    threadId = res.data.id;
    return null;
  });
  if (result.error) return result;

  for (const message of c.messages) {
    let text = '';
    let model: string | null = null;
    const tools: string[] = [];
    const actions: ProposedAction[] = [];
    const ms = await guarded(async (signal) => {
      const sent = await api.sendAssistantMessage(
        threadId,
        { content: message.content, language: c.language ?? 'vi' },
        { signal },
      );
      if (sent.events === undefined) {
        return {
          code: `http_${sent.response.status}`,
          message: describeBody(sent.error),
        };
      }
      let failure: TurnError | null = null;
      for await (const event of sent.events) {
        switch (event.event) {
          case 'tool.started':
            tools.push(event.data.tool);
            break;
          case 'action.proposed':
            actions.push({
              kind: event.data.kind,
              payload: event.data.payload,
            });
            break;
          case 'message.delta':
            text += event.data.text;
            break;
          case 'message.completed':
            model = event.data.model;
            if (event.data.usage.cost)
              (result.turn_costs_usd ??= []).push(
                event.data.usage.cost.total_usd,
              );
            break;
          case 'error':
            failure = { code: event.data.code, message: event.data.message_vi };
            break;
          default:
            break;
        }
      }
      return failure;
    });
    // Whatever arrived before a failure still counts.
    result.answer = text;
    result.tools.push(...tools);
    result.actions.push(...actions);
    result.model = result.error ? null : model;
    result.latency_ms = Math.max(result.latency_ms, ms);
    if (result.error) break;
  }
  return result;
}
