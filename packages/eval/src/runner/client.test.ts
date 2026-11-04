import { afterEach, describe, expect, it } from 'vitest';
import { FakeOracle } from '../oracle/provider.ts';
import { mkCase } from '../test-helpers.ts';
import type { AuthProvider } from './auth.ts';
import { StubAuth } from './auth.ts';
import { DEFAULT_TODAY, runTurns, type TurnOptions } from './client.ts';
import {
  startStubAssistant,
  type ReplyPlan,
  type StubHandle,
  type StubScript,
} from './stub-assistant.ts';

let stub: StubHandle | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function start(script: StubScript | ((req: never) => ReplyPlan)) {
  stub = await startStubAssistant(script as StubScript);
  return stub;
}

function opts(over: Partial<TurnOptions> = {}): TurnOptions {
  return {
    baseUrl: stub!.url,
    auth: new StubAuth(),
    oracle: new FakeOracle(),
    runId: 'eval-20261025T1015-ab12',
    ...over,
  };
}

describe('runTurns', () => {
  it('creates a thread, sends the message and collects the turn', async () => {
    await start({
      reply: () => ({
        tools: ['get_restock_plan', 'get_store_overview'],
        text: 'Cần nhập thêm 24 chai Coca.',
        model: 'stub/model-x',
        actions: [{ kind: 'reorder_list', payload: { items: [] } }],
      }),
    });
    const turn = await runTurns(opts(), mkCase());
    expect(turn).toMatchObject({
      answer: 'Cần nhập thêm 24 chai Coca.',
      tools: ['get_restock_plan', 'get_store_overview'],
      actions: [{ kind: 'reorder_list', payload: { items: [] } }],
      model: 'stub/model-x',
      error: null,
    });
    expect(turn.latency_ms).toBeGreaterThanOrEqual(0);

    const [create, send] = stub!.calls;
    expect(create).toMatchObject({
      method: 'POST',
      path: '/v1/assistant/threads',
    });
    expect(send!.path).toMatch(/^\/v1\/assistant\/threads\/[^/]+\/messages$/);
    expect(send!.body).toEqual({
      content: 'Tuần tới cần nhập thêm gì?',
      language: 'vi',
    });
  });

  it('collects actual costs separately for every turn and leaves missing accounting unknown', async () => {
    let i = 0;
    await start({
      reply: () => ({
        text: 'ok',
        ...(i++ === 0
          ? { cost: { input_usd: 0.001, output_usd: 0.002, total_usd: 0.003 } }
          : {}),
      }),
    });
    const turn = await runTurns(
      opts(),
      mkCase({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      }),
    );
    expect(turn.turn_costs_usd).toEqual([0.003]);
  });

  it('sends the eval headers and the auth headers on every request', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    await runTurns(opts(), mkCase({ role: 'seller' }));
    expect(stub!.calls).toHaveLength(2);
    for (const call of stub!.calls) {
      expect(call.headers['authorization']).toBe('Bearer stub-seller-token');
      expect(call.headers['x-taphoa-today']).toBe(DEFAULT_TODAY);
      expect(call.headers['x-taphoa-eval-run']).toBe('eval-20261025T1015-ab12');
      expect(call.headers['x-taphoa-eval-model']).toBeUndefined();
    }
    expect(DEFAULT_TODAY).toBe('2026-10-20');
  });

  it('sends a custom date and the model override', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    const turn = await runTurns(
      opts({ today: '2026-11-02', model: 'google/gemma-4-31b-it:free' }),
      mkCase(),
    );
    for (const call of stub!.calls) {
      expect(call.headers['x-taphoa-today']).toBe('2026-11-02');
      expect(call.headers['x-taphoa-eval-model']).toBe(
        'google/gemma-4-31b-it:free',
      );
    }
    expect(turn.model).toBe('google/gemma-4-31b-it:free');
  });

  it('asks the auth provider for the case role', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    const roles: string[] = [];
    const auth: AuthProvider = {
      headersFor: async (role) => {
        roles.push(role);
        return { Authorization: 'Bearer x', 'X-Store-Id': 'store-1' };
      },
    };
    await runTurns(opts({ auth }), mkCase({ role: 'seller' }));
    expect(new Set(roles)).toEqual(new Set(['seller']));
    expect(stub!.calls[0]!.headers['x-store-id']).toBe('store-1');
  });

  it('refuses a run id the backend would ignore', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    await expect(
      runTurns(opts({ runId: 'has spaces' }), mkCase()),
    ).rejects.toThrow('run id');
    await expect(
      runTurns(opts({ runId: 'x'.repeat(65) }), mkCase()),
    ).rejects.toThrow('run id');
  });

  it('passes the case language to the backend', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    await runTurns(opts(), mkCase({ language: 'en' }));
    expect((stub!.calls[1]!.body as { language: string }).language).toBe('en');
  });

  it('creates the thread with the context, resolving the receipt through the oracle', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    const oracle = new FakeOracle();
    await runTurns(
      opts({ oracle }),
      mkCase({
        context: { screen: 'receipt', receipt: 'receipt:draft-unmatched' },
      }),
    );
    expect(stub!.calls[0]!.body).toEqual({
      context: {
        screen: 'receipt',
        receipt_id: await oracle.resolveRef('receipt:draft-unmatched'),
      },
    });
  });

  it('gives the thread a screen when the case names only a receipt', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    await runTurns(opts(), mkCase({ context: { receipt: 'receipt:draft' } }));
    const body = stub!.calls[0]!.body as { context: { screen: string } };
    expect(typeof body.context.screen).toBe('string');
    expect(body.context.screen).not.toBe('');
  });

  it('creates a thread without a body context when the case has none', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    await runTurns(opts(), mkCase());
    expect(stub!.calls[0]!.body).toEqual({});
  });

  it('sends several messages in order and answers with the last turn', async () => {
    await start({
      reply: (req) =>
        req.turn === 0
          ? {
              tools: ['search_sales'],
              text: 'Hôm qua bán 12 chai Coca.',
              delayMs: 60,
            }
          : {
              tools: ['get_top_products'],
              text: 'Pepsi bán 8 chai.',
              delayMs: 10,
            },
    });
    const turn = await runTurns(
      opts(),
      mkCase({
        messages: [
          { role: 'user', content: 'Hôm qua bán mấy chai Coca?' },
          { role: 'user', content: 'Còn Pepsi?' },
        ],
      }),
    );
    expect(turn.answer).toBe('Pepsi bán 8 chai.');
    expect(turn.tools).toEqual(['search_sales', 'get_top_products']);
    expect(turn.latency_ms).toBeGreaterThanOrEqual(55);
    const sent = stub!.calls.filter((c) => c.path.endsWith('/messages'));
    expect(sent.map((c) => (c.body as { content: string }).content)).toEqual([
      'Hôm qua bán mấy chai Coca?',
      'Còn Pepsi?',
    ]);
    // both messages in the same thread
    expect(sent[0]!.path).toBe(sent[1]!.path);
  });

  it('turns an error event into turn.error and keeps the partial text', async () => {
    await start({
      reply: () => ({
        text: 'Đang xem số liệu',
        tools: ['get_sales_summary'],
        error: { code: 'model_unavailable', message_vi: 'Mô hình đang bận.' },
      }),
    });
    const turn = await runTurns(opts(), mkCase());
    expect(turn.error).toEqual({
      code: 'model_unavailable',
      message: 'Mô hình đang bận.',
    });
    expect(turn.answer).toBe('Đang xem số liệu');
    expect(turn.tools).toEqual(['get_sales_summary']);
    expect(turn.model).toBeNull();
  });

  it('stops at the first failing turn', async () => {
    await start({
      reply: (req) =>
        req.turn === 0
          ? { error: { code: 'quota', message_vi: 'Hết lượt.' } }
          : { text: 'không được gọi' },
    });
    const turn = await runTurns(
      opts(),
      mkCase({
        messages: [
          { role: 'user', content: 'một' },
          { role: 'user', content: 'hai' },
        ],
      }),
    );
    expect(turn.error?.code).toBe('quota');
    expect(
      stub!.calls.filter((c) => c.path.endsWith('/messages')),
    ).toHaveLength(1);
  });

  it('reports an HTTP error as turn.error', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    const auth: AuthProvider = { headersFor: async () => ({}) };
    const turn = await runTurns(opts({ auth }), mkCase());
    expect(turn.error?.code).toBe('http_401');
    expect(turn.answer).toBe('');
    expect(turn.tools).toEqual([]);
  });

  it('reports a stream that ends early', async () => {
    await start({ reply: () => ({ text: 'Đang trả lời', interrupt: true }) });
    const turn = await runTurns(opts(), mkCase());
    expect(turn.error?.code).toBe('stream_interrupted');
    expect(turn.answer).toBe('Đang trả lời');
  });

  it('reports a turn that exceeds the client timeout', async () => {
    await start({ reply: () => ({ text: 'chậm', delayMs: 1000 }) });
    const turn = await runTurns(opts({ turnTimeoutMs: 80 }), mkCase());
    expect(turn.error?.code).toBe('timeout');
  });

  it('reports a backend that cannot be reached', async () => {
    await start({ reply: () => ({ text: 'ok' }) });
    const url = stub!.url;
    await stub!.close();
    stub = null;
    const turn = await runTurns(
      {
        baseUrl: url,
        auth: new StubAuth(),
        oracle: new FakeOracle(),
        runId: 'eval-1',
      },
      mkCase(),
    );
    expect(turn.error?.code).toBe('network');
  });

  it('reads the digest for a digest case and uses its text as the answer', async () => {
    await start({
      reply: () => ({ text: 'unused' }),
      digest: () => ({
        summary_vi: 'Hôm qua cửa hàng bán được rất tốt.',
        sales: {
          revenue: 4500000,
          sale_count: 31,
          gross_profit: 900000,
          change_pct: 12.5,
        },
        restock: [
          {
            product_id: 'p1',
            name: 'Coca-Cola lon',
            quantity: 24,
            unit_cost: 8000,
            total_cost: 192000,
          },
        ],
      }),
    });
    const turn = await runTurns(
      opts(),
      mkCase({
        id: 'U13-01',
        use_case: 'U13',
        kind: 'digest',
        messages: [],
        pending: { on: 'X8', reason: 'x' },
      }),
    );
    expect(turn.error).toBeNull();
    expect(turn.tools).toEqual([]);
    expect(turn.actions).toEqual([]);
    expect(turn.model).toBeNull();
    expect(turn.answer).toContain('Hôm qua cửa hàng bán được rất tốt.');
    expect(turn.answer).toContain('4.500.000 ₫');
    expect(turn.answer).toContain('Coca-Cola lon');

    const [call] = stub!.calls;
    expect(call).toMatchObject({ method: 'GET', path: '/v1/assistant/digest' });
    expect(call!.query).toEqual({ business_date: DEFAULT_TODAY });
    expect(call!.headers['x-taphoa-eval-run']).toBe('eval-20261025T1015-ab12');
  });

  it('leaves the profit out of a seller digest', async () => {
    await start({
      reply: () => ({ text: 'unused' }),
      digest: () => ({
        summary_vi: 'Bản tin.',
        sales: {
          revenue: 1000000,
          sale_count: 5,
          gross_profit: null,
          change_pct: null,
        },
      }),
    });
    const turn = await runTurns(
      opts(),
      mkCase({
        kind: 'digest',
        messages: [],
        role: 'seller',
        pending: { on: 'X8', reason: 'x' },
      }),
    );
    expect(turn.answer).toContain('1.000.000 ₫');
    expect(turn.answer).not.toMatch(/lợi nhuận/i);
  });

  it('reports a missing digest as turn.error', async () => {
    await start({ reply: () => ({ text: 'unused' }) });
    const turn = await runTurns(
      opts(),
      mkCase({
        kind: 'digest',
        messages: [],
        pending: { on: 'X8', reason: 'x' },
      }),
    );
    expect(turn.error?.code).toBe('http_404');
  });
});
