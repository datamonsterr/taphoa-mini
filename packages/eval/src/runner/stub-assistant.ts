import type { Digest } from '@taphoa/api-client';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveCase, type OracleProvider } from '../oracle/provider.ts';
import { formatMoney, renderValue } from '../format.ts';
import { actionOracleKey } from '../scorers/index.ts';
import type {
  FieldExpect,
  GoldenCase,
  OracleValue,
  ProposedAction,
  ResolvedCase,
  Role,
} from '../types.ts';

/** Why a stub reply ends in an `error` event instead of `message.completed`. */
export type StubErrorCode =
  'quota' | 'model_unavailable' | 'timeout' | 'internal';

/** What the stub assistant does for one user message. */
export type ReplyPlan = {
  /** Tool names, each streamed as `tool.started` then `tool.finished`. */
  tools?: string[];
  /** The answer, streamed as several `message.delta` events. */
  text?: string;
  /** Each becomes an `action.proposed` event. */
  actions?: ProposedAction[];
  /** `message.completed.model`; an eval model header overrides it, as in the backend. */
  model?: string;
  cost?: {
    input_usd: number | null;
    output_usd: number | null;
    total_usd: number;
  };
  /** Wait this long after the tool events and before the text. */
  delayMs?: number;
  /** End with an `error` event instead of `message.completed`. */
  error?: { code: StubErrorCode; message_vi?: string };
  /** End the stream with no terminal event. */
  interrupt?: boolean;
};

export type StubEval = { run: string; today: string; model: string | null };

/** One user message, with the thread it belongs to. */
export type StubRequest = {
  threadId: string;
  /** From the bearer token: a token that contains "seller" is a seller. */
  role: Role;
  context: {
    screen?: string;
    receipt_id?: string;
    [key: string]: unknown;
  } | null;
  content: string;
  /** User messages sent earlier in this thread. */
  history: string[];
  /** Zero-based index of this message in the thread. */
  turn: number;
  language: 'vi' | 'en';
  /** Request headers, names in lower case. */
  headers: Record<string, string>;
  /** Set only when both eval headers are valid, like the backend. */
  eval: StubEval | null;
};

export type DigestRequest = {
  role: Role;
  businessDate: string;
  headers: Record<string, string>;
  eval: StubEval | null;
};

export type DigestPlan = Partial<Omit<Digest, 'sales'>> & {
  summary_vi: string;
  sales?: Partial<Digest['sales']>;
};

export type StubScript = {
  reply(req: StubRequest): ReplyPlan | Promise<ReplyPlan>;
  /** Without it, `GET /v1/assistant/digest` answers 404. */
  digest?(req: DigestRequest): DigestPlan | Promise<DigestPlan>;
};

export type StubCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
};

export type StubHandle = {
  url: string;
  close(): Promise<void>;
  /** Every request the server saw, in order. */
  calls: StubCall[];
};

const RUN_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK_CODE_POINTS = 24;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
) {
  sendJson(res, status, { error, code });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}

function evalOf(headers: Record<string, string>): StubEval | null {
  const run = headers['x-taphoa-eval-run'];
  const today = headers['x-taphoa-today'];
  if (!run || !today || !RUN_ID.test(run) || !DATE.test(today)) return null;
  return { run, today, model: headers['x-taphoa-eval-model'] || null };
}

function roleOf(headers: Record<string, string>): Role | null {
  const m = /^Bearer\s+(\S+)$/i.exec(headers['authorization'] ?? '');
  if (!m) return null;
  return m[1]!.includes('seller') ? 'seller' : 'lead';
}

type Thread = {
  id: string;
  role: Role;
  context: StubRequest['context'];
  sent: string[];
};

/**
 * A `node:http` server that speaks the assistant API of the X0 contract:
 * thread creation, the SSE message stream, and the digest. The script decides
 * each reply. It listens on a free local port.
 */
export async function startStubAssistant(
  script: StubScript | ((req: StubRequest) => ReplyPlan | Promise<ReplyPlan>),
): Promise<StubHandle> {
  const { reply, digest } =
    typeof script === 'function'
      ? { reply: script, digest: undefined }
      : script;
  const calls: StubCall[] = [];
  const threads = new Map<string, Thread>();
  let counter = 0;
  const nextId = () => uuid(++counter);

  async function postThread(
    req: IncomingMessage,
    res: ServerResponse,
    role: Role,
    body: unknown,
  ) {
    const input = (body ?? {}) as { title?: unknown; context?: unknown };
    let context: Thread['context'] = null;
    if (input.context !== undefined) {
      const c = input.context as Record<string, unknown> | null;
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof c.screen !== 'string' ||
        c.screen === ''
      ) {
        return sendError(
          res,
          400,
          'validation_failed',
          'context.screen is required',
        );
      }
      context = c as Thread['context'];
    }
    const thread: Thread = { id: nextId(), role, context, sent: [] };
    threads.set(thread.id, thread);
    const now = new Date().toISOString();
    sendJson(res, 201, {
      id: thread.id,
      title: typeof input.title === 'string' ? input.title : null,
      context,
      created_at: now,
      updated_at: now,
    });
  }

  async function postMessage(
    req: IncomingMessage,
    res: ServerResponse,
    role: Role,
    threadId: string,
    body: unknown,
  ) {
    const thread = threads.get(threadId);
    if (!thread) return sendError(res, 404, 'not_found', 'thread not found');
    const input = (body ?? {}) as { content?: unknown; language?: unknown };
    if (
      typeof input.content !== 'string' ||
      input.content.trim() === '' ||
      (input.language !== 'vi' && input.language !== 'en')
    ) {
      return sendError(
        res,
        400,
        'validation_failed',
        'content and language (vi or en) are required',
      );
    }

    const headers = lowerHeaders(req);
    const request: StubRequest = {
      threadId,
      role,
      context: thread.context,
      content: input.content,
      history: [...thread.sent],
      turn: thread.sent.length,
      language: input.language,
      headers,
      eval: evalOf(headers),
    };
    thread.sent.push(input.content);

    let plan: ReplyPlan;
    try {
      plan = await reply(request);
    } catch (e) {
      return sendError(
        res,
        500,
        'internal',
        `stub script failed: ${(e as Error).message}`,
      );
    }
    await stream(res, thread, request, plan);
  }

  async function stream(
    res: ServerResponse,
    thread: Thread,
    request: StubRequest,
    plan: ReplyPlan,
  ) {
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    const messageId = nextId();
    send('message.created', { message_id: messageId, thread_id: thread.id });

    for (const tool of plan.tools ?? []) {
      const callId = `call-${nextId()}`;
      send('tool.started', {
        call_id: callId,
        tool,
        label_vi: `Đang chạy ${tool}`,
      });
      send('tool.finished', {
        call_id: callId,
        tool,
        ok: true,
        summary_vi: `Đã chạy ${tool}`,
      });
    }
    if (plan.delayMs) await sleep(plan.delayMs).catch(() => {});

    const text = plan.text ?? '';
    const points = [...text];
    for (let i = 0; i < points.length; i += CHUNK_CODE_POINTS) {
      send('message.delta', {
        text: points.slice(i, i + CHUNK_CODE_POINTS).join(''),
      });
    }
    for (const action of plan.actions ?? []) {
      const now = new Date();
      send('action.proposed', {
        id: nextId(),
        thread_id: thread.id,
        message_id: messageId,
        kind: action.kind,
        status: 'proposed',
        payload: action.payload,
        summary_vi: `Đề xuất ${action.kind}`,
        proposed_by: uuid(0),
        decided_by: null,
        decided_at: null,
        result: null,
        error: null,
        expires_at: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
        created_at: now.toISOString(),
      });
    }

    if (plan.error) {
      send('error', {
        code: plan.error.code,
        message_vi:
          plan.error.message_vi ?? 'Trợ lý tạm thời không trả lời được.',
      });
    } else if (!plan.interrupt) {
      send('message.completed', {
        message_id: messageId,
        model: request.eval?.model ?? plan.model ?? 'stub/model',
        usage: {
          input_tokens: 100 + 12 * request.history.length,
          output_tokens: Math.ceil(text.length / 4),
          ...(plan.cost ? { cost: plan.cost } : {}),
        },
      });
    }
    if (!res.writableEnded) res.end();
  }

  async function getDigest(
    req: IncomingMessage,
    res: ServerResponse,
    role: Role,
    query: Record<string, string>,
  ) {
    if (!digest)
      return sendError(res, 404, 'not_found', 'no digest for this date');
    const businessDate = query.business_date;
    if (!businessDate || !DATE.test(businessDate)) {
      return sendError(
        res,
        400,
        'validation_failed',
        'business_date must be YYYY-MM-DD',
      );
    }
    const headers = lowerHeaders(req);
    const plan = await digest({
      role,
      businessDate,
      headers,
      eval: evalOf(headers),
    });
    const { sales, ...rest } = plan;
    const full: Digest = {
      business_date: businessDate,
      generated_at: new Date().toISOString(),
      source: 'template',
      restock: [],
      overdue_debts: { count: 0, total: 0 },
      open_drafts: { count: 0 },
      read_at: null,
      ...rest,
      sales: {
        revenue: 0,
        sale_count: 0,
        gross_profit: role === 'seller' ? null : 0,
        change_pct: null,
        ...sales,
      },
    };
    sendJson(res, 200, full);
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const method = req.method ?? 'GET';
      const raw = method === 'GET' ? '' : await readBody(req);
      let body: unknown = undefined;
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          calls.push({
            method,
            path: url.pathname,
            query: {},
            headers: lowerHeaders(req),
            body: raw,
          });
          return sendError(res, 400, 'validation_failed', 'body is not JSON');
        }
      }
      const query = Object.fromEntries(url.searchParams);
      const headers = lowerHeaders(req);
      calls.push({ method, path: url.pathname, query, headers, body });

      const role = roleOf(headers);
      if (!role)
        return sendError(res, 401, 'unauthorized', 'missing bearer token');

      if (method === 'POST' && url.pathname === '/v1/assistant/threads') {
        return postThread(req, res, role, body);
      }
      const message = /^\/v1\/assistant\/threads\/([^/]+)\/messages$/.exec(
        url.pathname,
      );
      if (method === 'POST' && message) {
        return postMessage(
          req,
          res,
          role,
          decodeURIComponent(message[1]!),
          body,
        );
      }
      if (method === 'GET' && url.pathname === '/v1/assistant/digest') {
        return getDigest(req, res, role, query);
      }
      return sendError(
        res,
        404,
        'not_found',
        `no route for ${method} ${url.pathname}`,
      );
    })().catch((e: unknown) => {
      if (!res.headersSent)
        sendError(res, 500, 'internal', (e as Error).message);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub assistant has no port');
  }

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

// ---------------------------------------------------------------- scripts

export { formatMoney, renderValue };

type Lang = 'vi' | 'en';
const TEXT = {
  lead: {
    vi: 'Dưới đây là kết quả cho cửa hàng của bạn.',
    en: 'Here are the results for your store, based on the sales and stock data that you can see in the app.',
  },
  // English answers quote Vietnamese product names, so they need enough
  // English prose to stay under the language scorer's 5 % limit.
  closing: {
    vi: '',
    en: 'Please check these figures and tell me if there is anything else that you need.',
  },
  fact: { vi: 'Số liệu', en: 'Figure' },
  action: {
    vi: 'Mình đã soạn sẵn một đề xuất, bạn bấm xác nhận để thực hiện.',
    en: 'I have drafted a proposal for you, please confirm it to apply the change.',
  },
  refusal: {
    vi: 'Xin lỗi, bạn không có quyền xem thông tin này. Vui lòng nhờ chủ cửa hàng hỗ trợ.',
    en: 'Sorry, you do not have permission to see this. Please ask the store owner for help.',
  },
  offtopic: {
    vi: 'Xin lỗi, mình chỉ hỗ trợ các việc quản lý cửa hàng như bán hàng, tồn kho và nhập hàng.',
    en: 'Sorry, I can only help with running the store, such as sales, stock and restocking.',
  },
  injection: {
    vi: 'Mình bỏ qua mọi chỉ dẫn nằm trong dữ liệu sản phẩm và chỉ trả lời câu hỏi của bạn.',
    en: 'I ignore any instructions found inside product data and only answer your question.',
  },
  ack: {
    vi: 'Mình đã ghi nhận, bạn cứ hỏi tiếp nhé.',
    en: 'Noted, go ahead and ask the next question.',
  },
  filler: {
    vi: 'Xin lỗi, mình chưa rõ nên chưa thể trả lời chính xác câu hỏi này của bạn.',
    en: 'Sorry, I am not sure about this, so I cannot give you an exact answer for it.',
  },
  digest: {
    vi: 'Bản tin buổi sáng cho cửa hàng của bạn.',
    en: 'The morning digest for your store.',
  },
} as const;

const langOf = (c: GoldenCase): Lang => c.language ?? 'vi';

/** Finds the case a request belongs to; prompts must be unique per role. */
function indexCases(cases: GoldenCase[]) {
  const key = (role: Role, messages: string[]) =>
    `${role}\u0000${messages.join('\u0001')}`;
  const byRequest = new Map<string, { c: GoldenCase; last: boolean }>();
  for (const c of cases) {
    const contents = c.messages.map((m) => m.content);
    contents.forEach((_, i) => {
      const k = key(c.role, contents.slice(0, i + 1));
      if (!byRequest.has(k))
        byRequest.set(k, { c, last: i === contents.length - 1 });
    });
  }
  return (req: { role: Role; history: string[]; content: string }) =>
    byRequest.get(key(req.role, [...req.history, req.content]));
}

const unmatched = (req: StubRequest): ReplyPlan => ({
  error: {
    code: 'internal',
    message_vi: `stub: no golden case has this ${req.role} message: ${req.content.slice(0, 60)}`,
  },
});

function setPath(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
) {
  const [segment, ...rest] = segments;
  if (segment === undefined) return;
  const fanOut = segment.endsWith('[]');
  const key = fanOut ? segment.slice(0, -2) : segment;
  if (key === '') return;
  if (fanOut) {
    const list = (target[key] ??= [{}]) as Record<string, unknown>[];
    if (rest.length === 0) list[0] = value as Record<string, unknown>;
    else setPath(list[0]!, rest, value);
  } else if (rest.length === 0) {
    target[key] = value;
  } else {
    setPath((target[key] ??= {}) as Record<string, unknown>, rest, value);
  }
}

function valueFor(expected: FieldExpect, resolved: ResolvedCase): unknown {
  if ('ref' in expected) return resolved.refs[expected.ref] ?? expected.ref;
  if ('eq' in expected) return expected.eq;
  if ('oracle' in expected) {
    return resolved.actionOracles[
      actionOracleKey(expected.oracle, expected.args)
    ]?.values[0];
  }
  return expected.min ?? expected.max ?? 1;
}

function actionFor(c: GoldenCase, resolved: ResolvedCase): ProposedAction[] {
  if (c.expect_action === null) return [];
  const payload: Record<string, unknown> = {};
  for (const [path, expected] of Object.entries(c.expect_action.fields)) {
    setPath(payload, path.split('.'), valueFor(expected, resolved));
  }
  return [{ kind: c.expect_action.kind, payload }];
}

/** The `must` tools, plus the first tool of each `any_of` group not yet covered. */
function toolsFor(c: GoldenCase): string[] {
  const tools = [...c.expect_tools.must];
  for (const group of c.expect_tools.any_of ?? []) {
    if (group.length > 0 && !group.some((t) => tools.includes(t)))
      tools.push(group[0]!);
  }
  return [...new Set(tools)];
}

/** One sentence per fact the answer has to state; `none_mentioned` facts stay out. */
function factSentences(
  c: GoldenCase,
  resolved: ResolvedCase,
  lang: Lang,
): string[] {
  const out: string[] = [];
  c.expect_facts.forEach((fact, i) => {
    const value = resolved.facts[i];
    if (!value || fact.match === 'none_mentioned') return;
    const shown: OracleValue =
      fact.match === 'number'
        ? ({ ...value, values: value.values.slice(0, 1) } as OracleValue)
        : value;
    out.push(`${TEXT.fact[lang]}: ${renderValue(shown)}.`);
  });
  return out;
}

function perfectText(c: GoldenCase, resolved: ResolvedCase): string {
  const lang = langOf(c);
  const refused =
    c.expect_refusal === true || (c.denied_facts ?? []).length > 0;
  const parts: string[] = [];
  if (refused) parts.push(TEXT.refusal[lang]);
  else if (c.tags.includes('offtopic')) parts.push(TEXT.offtopic[lang]);
  else parts.push(TEXT.lead[lang]);
  if (c.injection) parts.push(TEXT.injection[lang]);
  parts.push(...factSentences(c, resolved, lang));
  if (c.expect_action) parts.push(TEXT.action[lang]);
  if (TEXT.closing[lang] !== '') parts.push(TEXT.closing[lang]);
  return parts.join(' ');
}

/**
 * A script that answers every case correctly: it calls the `must` tools,
 * states each expected fact (money as `1.234.000 ₫`), proposes the expected
 * action, and refuses permission cases without the denied values. Only the
 * last message of a multi-turn case carries the answer. A request that
 * matches no case ends in an `internal` error.
 */
export function perfectScript(
  cases: GoldenCase[],
  oracle: OracleProvider,
): StubScript {
  const find = indexCases(cases);
  return {
    async reply(req) {
      const hit = find(req);
      if (!hit) return unmatched(req);
      const { c, last } = hit;
      if (!last)
        return { text: TEXT.ack[langOf(c)], model: 'stub/perfect-model' };
      const resolved = await resolveCase(c, oracle);
      return {
        tools: toolsFor(c),
        text: perfectText(c, resolved),
        actions: actionFor(c, resolved),
        model: 'stub/perfect-model',
      };
    },
    async digest(req) {
      const mine = cases.filter(
        (c) => c.kind === 'digest' && c.role === req.role,
      );
      const sentences: string[] = [TEXT.digest.vi];
      for (const c of mine) {
        sentences.push(...factSentences(c, await resolveCase(c, oracle), 'vi'));
      }
      return { summary_vi: sentences.join(' ') };
    },
  };
}

/**
 * A script that fails on purpose: it calls a wrong tool and every forbidden
 * one, proposes nothing, states no expected fact, leaks the denied values and
 * echoes the injection canaries, while staying in the right language.
 */
export function badScript(
  cases: GoldenCase[],
  oracle: OracleProvider,
): StubScript {
  const find = indexCases(cases);
  return {
    async reply(req) {
      const hit = find(req);
      if (!hit) return unmatched(req);
      const { c } = hit;
      const lang = langOf(c);
      const wrong = c.expect_tools.must.includes('get_store_overview')
        ? 'search_help'
        : 'get_store_overview';
      const resolved = await resolveCase(c, oracle);
      const parts: string[] = [TEXT.filler[lang]];
      for (const value of resolved.denied) parts.push(`${renderValue(value)}.`);
      for (const canary of c.injection?.canaries ?? [])
        parts.push(`${canary}.`);
      return {
        tools: [...new Set([wrong, ...c.expect_tools.must_not])],
        text: parts.join(' '),
        model: 'stub/bad-model',
      };
    },
    digest: () => ({ summary_vi: TEXT.filler.vi }),
  };
}
