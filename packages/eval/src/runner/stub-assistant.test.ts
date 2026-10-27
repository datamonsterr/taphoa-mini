import { parseSseStream } from '@taphoa/api-client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeOracle, resolveCase } from '../oracle/provider.ts';
import { scoreCase } from '../scorers/index.ts';
import type { GoldenCase, TurnResult } from '../types.ts';
import { STUB_TOKENS } from './auth.ts';
import { loadFixtureCases } from './fixtures.ts';
import {
  badScript,
  formatMoney,
  perfectScript,
  renderValue,
  startStubAssistant,
  type ReplyPlan,
  type StubHandle,
  type StubRequest,
  type StubScript,
} from './stub-assistant.ts';

let stub: StubHandle | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

const authHeaders = { authorization: `Bearer ${STUB_TOKENS.lead}` };
const json = { 'content-type': 'application/json' };

async function start(
  reply: (req: StubRequest) => ReplyPlan | Promise<ReplyPlan>,
) {
  stub = await startStubAssistant({ reply });
  return stub;
}

async function createThread(url: string, body: unknown = {}) {
  return fetch(`${url}/v1/assistant/threads`, {
    method: 'POST',
    headers: { ...json, ...authHeaders },
    body: JSON.stringify(body),
  });
}

async function frames(res: Response) {
  const out: { event: string; data: any }[] = [];
  for await (const f of parseSseStream(res.body!)) {
    out.push({ event: f.event, data: JSON.parse(f.data) });
  }
  return out;
}

describe('stub assistant HTTP', () => {
  it('creates a thread and echoes its context', async () => {
    const { url } = await start(() => ({ text: 'x' }));
    const res = await createThread(url, {
      context: { screen: 'camera', receipt_id: 'r-1' },
    });
    expect(res.status).toBe(201);
    const thread = await res.json();
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(thread.context).toEqual({ screen: 'camera', receipt_id: 'r-1' });
    expect(thread.title).toBeNull();
  });

  it('rejects a context without a screen, like the real contract', async () => {
    const { url } = await start(() => ({ text: 'x' }));
    const res = await createThread(url, { context: { receipt_id: 'r-1' } });
    expect(res.status).toBe(400);
  });

  it('answers 401 without a bearer token', async () => {
    const { url } = await start(() => ({ text: 'x' }));
    const res = await fetch(`${url}/v1/assistant/threads`, {
      method: 'POST',
      headers: json,
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('answers 404 for an unknown thread and 400 for a bad body', async () => {
    const { url } = await start(() => ({ text: 'x' }));
    const missing = await fetch(`${url}/v1/assistant/threads/nope/messages`, {
      method: 'POST',
      headers: { ...json, ...authHeaders },
      body: JSON.stringify({ content: 'hi', language: 'vi' }),
    });
    expect(missing.status).toBe(404);

    const thread = await (await createThread(url)).json();
    const bad = await fetch(
      `${url}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: { ...json, ...authHeaders },
        body: JSON.stringify({ content: '', language: 'fr' }),
      },
    );
    expect(bad.status).toBe(400);
  });

  it('streams the X0 events in order, with the text in several deltas', async () => {
    const text = 'Cần nhập thêm Coca, Pepsi và Sting trong tuần tới. '.repeat(
      3,
    );
    const { url } = await start(() => ({
      tools: ['get_restock_plan', 'get_store_overview'],
      text,
      model: 'stub/model-x',
    }));
    const thread = await (await createThread(url)).json();
    const res = await fetch(
      `${url}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: { ...json, ...authHeaders, accept: 'text/event-stream' },
        body: JSON.stringify({
          content: 'Tuần tới cần nhập gì?',
          language: 'vi',
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = await frames(res);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('message.created');
    expect(names.at(-1)).toBe('message.completed');
    expect(names.filter((n) => n === 'tool.started')).toHaveLength(2);
    expect(names.filter((n) => n === 'tool.finished')).toHaveLength(2);
    expect(names.indexOf('tool.started')).toBeLessThan(
      names.indexOf('message.delta'),
    );
    const deltas = events.filter((e) => e.event === 'message.delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.data.text).join('')).toBe(text);

    expect(events[0]!.data).toMatchObject({ thread_id: thread.id });
    const started = events.find((e) => e.event === 'tool.started')!;
    expect(started.data).toMatchObject({
      tool: 'get_restock_plan',
      call_id: expect.any(String),
      label_vi: expect.any(String),
    });
    const finished = events.find((e) => e.event === 'tool.finished')!;
    expect(finished.data).toMatchObject({
      ok: true,
      summary_vi: expect.any(String),
    });
    expect(events.at(-1)!.data).toMatchObject({
      model: 'stub/model-x',
      usage: {
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      },
    });
  });

  it('streams a proposed action as a full AssistantAction', async () => {
    const { url } = await start(() => ({
      text: 'Đã soạn đề xuất.',
      actions: [
        {
          kind: 'price_change',
          payload: { product_id: 'p1', new_price: 9000 },
        },
      ],
    }));
    const thread = await (await createThread(url)).json();
    const res = await fetch(
      `${url}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: { ...json, ...authHeaders },
        body: JSON.stringify({ content: 'đổi giá', language: 'vi' }),
      },
    );
    const events = await frames(res);
    const proposed = events.find((e) => e.event === 'action.proposed')!;
    expect(proposed.data).toMatchObject({
      kind: 'price_change',
      status: 'proposed',
      payload: { product_id: 'p1', new_price: 9000 },
      thread_id: thread.id,
    });
  });

  it('ends with an error event instead of message.completed', async () => {
    const { url } = await start(() => ({
      error: { code: 'quota', message_vi: 'Hết lượt dùng hôm nay.' },
    }));
    const thread = await (await createThread(url)).json();
    const res = await fetch(
      `${url}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: { ...json, ...authHeaders },
        body: JSON.stringify({ content: 'hi', language: 'vi' }),
      },
    );
    const events = await frames(res);
    expect(events.map((e) => e.event)).toEqual(['message.created', 'error']);
    expect(events[1]!.data).toEqual({
      code: 'quota',
      message_vi: 'Hết lượt dùng hôm nay.',
    });
  });

  it('gives the script the thread context, history, role and headers', async () => {
    const seen: StubRequest[] = [];
    const { url } = await start((req) => {
      seen.push(req);
      return { text: 'ok' };
    });
    const thread = await (
      await createThread(url, {
        context: { screen: 'receipt', receipt_id: 'r-9' },
      })
    ).json();
    const send = (content: string, extra: Record<string, string> = {}) =>
      fetch(`${url}/v1/assistant/threads/${thread.id}/messages`, {
        method: 'POST',
        headers: {
          ...json,
          authorization: `Bearer ${STUB_TOKENS.seller}`,
          ...extra,
        },
        body: JSON.stringify({ content, language: 'en' }),
      }).then((r) => r.text());
    await send('one', {
      'X-Taphoa-Eval-Run': 'eval-1',
      'X-Taphoa-Today': '2026-10-20',
      'X-Taphoa-Eval-Model': 'some/model:free',
    });
    await send('two');

    expect(seen[0]).toMatchObject({
      threadId: thread.id,
      role: 'seller',
      content: 'one',
      history: [],
      turn: 0,
      language: 'en',
      context: { screen: 'receipt', receipt_id: 'r-9' },
      eval: { run: 'eval-1', today: '2026-10-20', model: 'some/model:free' },
    });
    expect(seen[1]).toMatchObject({
      content: 'two',
      history: ['one'],
      turn: 1,
      eval: null,
    });
  });

  it('only honours the eval headers when both run and today are present', async () => {
    const seen: StubRequest[] = [];
    const { url } = await start((req) => {
      seen.push(req);
      return { text: 'ok' };
    });
    const thread = await (await createThread(url)).json();
    await fetch(`${url}/v1/assistant/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { ...json, ...authHeaders, 'X-Taphoa-Eval-Run': 'eval-1' },
      body: JSON.stringify({ content: 'hi', language: 'vi' }),
    }).then((r) => r.text());
    expect(seen[0]!.eval).toBeNull();
  });

  it('reports the eval model override as the answering model', async () => {
    const { url } = await start(() => ({ text: 'ok' }));
    const thread = await (await createThread(url)).json();
    const res = await fetch(
      `${url}/v1/assistant/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: {
          ...json,
          ...authHeaders,
          'X-Taphoa-Eval-Run': 'eval-1',
          'X-Taphoa-Today': '2026-10-20',
          'X-Taphoa-Eval-Model': 'some/model:free',
        },
        body: JSON.stringify({ content: 'hi', language: 'vi' }),
      },
    );
    const events = await frames(res);
    expect(events.at(-1)!.data.model).toBe('some/model:free');
  });

  it('serves the digest from the script, or 404', async () => {
    const none = await start(() => ({ text: 'x' }));
    const missing = await fetch(
      `${none.url}/v1/assistant/digest?business_date=2026-10-20`,
      { headers: authHeaders },
    );
    expect(missing.status).toBe(404);
    await stub!.close();

    const script: StubScript = {
      reply: () => ({ text: 'x' }),
      digest: (req) => ({ summary_vi: `Bản tin ${req.businessDate}` }),
    };
    stub = await startStubAssistant(script);
    const res = await fetch(
      `${stub.url}/v1/assistant/digest?business_date=2026-10-20`,
      { headers: authHeaders },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      business_date: '2026-10-20',
      summary_vi: 'Bản tin 2026-10-20',
      source: 'template',
    });
  });

  it('logs every call', async () => {
    const handle = await start(() => ({ text: 'ok' }));
    await createThread(handle.url, { context: { screen: 'x' } });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/assistant/threads',
      body: { context: { screen: 'x' } },
    });
  });
});

describe('formatMoney and renderValue', () => {
  it('formats đồng with dots and the ₫ sign', () => {
    expect(formatMoney(1234000)).toBe('1.234.000 ₫');
    expect(formatMoney(500)).toBe('500 ₫');
    expect(formatMoney(-50000)).toBe('-50.000 ₫');
  });

  it('renders each oracle value kind', () => {
    expect(renderValue({ kind: 'names', values: ['Coca', 'Pepsi'] })).toBe(
      'Coca, Pepsi',
    );
    expect(renderValue({ kind: 'money', values: [1500000] })).toBe(
      '1.500.000 ₫',
    );
    expect(renderValue({ kind: 'percent', values: [12.5] })).toBe('12,5%');
    expect(renderValue({ kind: 'count', values: [24] })).toBe('24');
    expect(renderValue({ kind: 'count', values: [1234] })).toBe('1.234');
  });
});

describe('perfectScript and badScript', () => {
  const cases = loadFixtureCases();
  const oracle = new FakeOracle();
  const live = cases.filter((c) => !c.pending);

  function requestFor(c: GoldenCase, turn: number): StubRequest {
    return {
      threadId: 't-1',
      role: c.role,
      context: c.context ?? null,
      content: c.messages[turn]!.content,
      history: c.messages.slice(0, turn).map((m) => m.content),
      turn,
      language: c.language ?? 'vi',
      headers: {},
      eval: null,
    };
  }

  /** Play a case against a script without HTTP, as the client would. */
  async function play(script: StubScript, c: GoldenCase): Promise<TurnResult> {
    const tools: string[] = [];
    const actions: TurnResult['actions'] = [];
    let answer = '';
    let error: TurnResult['error'] = null;
    for (let i = 0; i < c.messages.length; i++) {
      const plan = await script.reply(requestFor(c, i));
      tools.push(...(plan.tools ?? []));
      actions.push(...(plan.actions ?? []));
      answer = plan.text ?? '';
      if (plan.error)
        error = { code: plan.error.code, message: plan.error.message_vi ?? '' };
    }
    return { answer, tools, actions, model: 'stub/x', latency_ms: 10, error };
  }

  it('perfectScript scores every fixture case at the top', async () => {
    const script = perfectScript(cases, oracle);
    for (const c of live) {
      const turn = await play(script, c);
      const resolved = await resolveCase(c, oracle);
      const scores = scoreCase(c, turn, resolved, 5);
      for (const s of scores) {
        if (s.scorer === 'latency_ms') continue;
        if (s.scorer === 'permission_leak') {
          expect(s.value, `${c.id} ${s.scorer}`).toBe(0);
        } else {
          expect(s.value, `${c.id} ${s.scorer}`).toBeGreaterThanOrEqual(
            s.scorer === 'judge' ? 5 : 1,
          );
        }
      }
    }
  });

  it('perfectScript calls the must tools and proposes the expected action', async () => {
    const script = perfectScript(cases, oracle);
    const action = live.find((c) => c.id === 'U11-01')!;
    const plan = await script.reply(requestFor(action, 0));
    expect(plan.tools).toContain('propose_price_change');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions![0]!.kind).toBe('price_change');
    expect(plan.actions![0]!.payload.product_id).toBe(
      await oracle.resolveRef('product:Coca-Cola lon 330ml'),
    );
  });

  it('perfectScript refuses a permission case without denied values', async () => {
    const script = perfectScript(cases, oracle);
    const c = live.find((x) => x.id === 'U3-03')!;
    const plan = await script.reply(requestFor(c, 0));
    expect(plan.tools ?? []).toEqual([]);
    for (const f of c.denied_facts!) {
      const value = await oracle.value(f);
      for (const v of value.values) expect(plan.text).not.toContain(String(v));
    }
  });

  it('perfectScript answers a multi-turn case from the last turn', async () => {
    const script = perfectScript(cases, oracle);
    const c = live.find((x) => x.id === 'U16-02')!;
    const first = await script.reply(requestFor(c, 0));
    const last = await script.reply(requestFor(c, 1));
    expect(first.tools ?? []).toEqual([]);
    expect(last.tools).toContain('search_sales');
  });

  it('perfectScript answers in English when the case asks for it', async () => {
    const script = perfectScript(cases, oracle);
    const c = live.find((x) => x.id === 'U4-02')!;
    const plan = await script.reply(requestFor(c, 0));
    expect(plan.text).toMatch(/\bthe\b/);
  });

  it('perfectScript errors on a request that matches no case', async () => {
    const script = perfectScript(cases, oracle);
    const plan = await script.reply({
      ...requestFor(live[0]!, 0),
      content: 'một câu chưa từng có',
    });
    expect(plan.error?.code).toBe('internal');
  });

  it('perfectScript builds a digest for the role', async () => {
    const digestCase: GoldenCase = {
      ...cases.find((c) => c.id === 'U13-01')!,
      pending: undefined,
    };
    const script = perfectScript([digestCase], oracle);
    const digest = await script.digest!({
      role: 'lead',
      businessDate: '2026-10-20',
      headers: {},
      eval: null,
    });
    const value = await oracle.value(digestCase.expect_facts[0]!);
    expect(digest.summary_vi).toContain(renderValue(value));
  });

  it('badScript fails every scorer a case can fail', async () => {
    const script = badScript(cases, oracle);
    for (const c of live) {
      const turn = await play(script, c);
      const resolved = await resolveCase(c, oracle);
      const byScorer = Object.fromEntries(
        scoreCase(c, turn, resolved, null).map((s) => [s.scorer, s.value]),
      );
      if (
        c.expect_tools.must.length > 0 ||
        c.expect_tools.must_not.length > 0
      ) {
        expect(byScorer.tool_selection, `${c.id} tool_selection`).toBe(0);
      }
      if (c.expect_facts.some((f) => f.match !== 'none_mentioned')) {
        expect(byScorer.facts, `${c.id} facts`).toBe(0);
      }
      if (c.expect_action) expect(byScorer.action, `${c.id} action`).toBe(0);
      if (c.denied_facts?.length) {
        expect(byScorer.permission_leak, `${c.id} leak`).toBe(1);
      }
      if (c.injection) {
        expect(byScorer.injection_resisted, `${c.id} injection`).toBe(0);
      }
      expect(byScorer.language, `${c.id} language`).toBe(1);
    }
  });
});
