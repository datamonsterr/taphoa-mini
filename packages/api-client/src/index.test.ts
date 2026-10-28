import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createApiClient, type components, type paths } from './index';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const image = {
  id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
  object_key: 'images/2026/10/x.jpg',
  content_type: 'image/jpeg',
  byte_size: 3,
  url: 'https://cdn.example.test/x.jpg',
  url_expires_at: '2026-10-23T10:00:00Z',
};

function setup(response: Response, token: string | null = null) {
  const fetchMock = vi.fn(async (_req: Request) => response);
  const api = createApiClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
    getToken: () => token,
  });
  return { api, fetchMock };
}

describe('api client', () => {
  it('getHealth calls GET /healthz and returns typed data', async () => {
    const { api, fetchMock } = setup(json({ status: 'ok' }));
    const { data, error } = await api.getHealth();
    expect(error).toBeUndefined();
    expect(data?.status).toBe('ok');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.test/healthz');
  });

  it('getImage sends the bearer token and path param', async () => {
    const { api, fetchMock } = setup(json(image), 'tok');
    const { data } = await api.getImage(image.id);
    expect(data?.id).toBe(image.id);
    const req = fetchMock.mock.calls[0]![0];
    expect(req.url).toBe(`https://api.example.test/v1/images/${image.id}`);
    expect(req.headers.get('Authorization')).toBe('Bearer tok');
  });

  it.each([false, true])(
    'sends X-Store-Id on every request (async: %s)',
    async (asyncStoreId) => {
      const fetchMock = vi.fn(async (_req: Request) => json(image));
      const api = createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock as unknown as typeof fetch,
        getToken: () => 'tok',
        getStoreId: asyncStoreId ? async () => image.id : () => image.id,
      });
      await api.getHealth();
      await api.getImage(image.id);
      await api.uploadImage(new Blob(['photo']));
      await api.raw.GET('/v1/me');
      for (const [request] of fetchMock.mock.calls) {
        expect(request.headers.get('X-Store-Id')).toBe(image.id);
        expect(request.headers.get('Authorization')).toBe('Bearer tok');
      }
    },
  );

  it.each([null, undefined])(
    'omits X-Store-Id when the callback returns %s',
    async (storeId) => {
      const fetchMock = vi.fn(async (_req: Request) => json(image));
      const getStoreId = vi.fn(() => storeId);
      const api = createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock as unknown as typeof fetch,
        getStoreId,
      });
      await api.getImage(image.id);
      expect(getStoreId).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0].headers.has('X-Store-Id')).toBe(false);
    },
  );

  it('getImage surfaces error responses', async () => {
    const { api } = setup(
      json({ code: 'not_found', message: 'nope' }, 404),
      'tok',
    );
    const { data, error, response } = await api.getImage(image.id);
    expect(data).toBeUndefined();
    expect(error).toBeDefined();
    expect(response.status).toBe(404);
  });

  it('uploadImage posts multipart form data', async () => {
    const { api, fetchMock } = setup(json(image, 201), 'tok');
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const { data, response } = await api.uploadImage(file, 'enrollment');
    expect(response.status).toBe(201);
    expect(data?.content_type).toBe('image/jpeg');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.test/v1/images');
    expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    const form = await req.formData();
    expect(form.get('purpose')).toBe('enrollment');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });

  describe('voice helpers', () => {
    const ctx = { entry: 'longpress' as const, screen: 'camera' };
    const utterance = {
      id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
      mode: 'sale',
      transcript: 'hai chai sting',
      language: 'vi',
      intent: 'sale',
      model: 'test/model',
      latency_ms: 900,
      created_at: '2026-10-27T00:00:00Z',
    };

    it('createVoiceUtterance posts multipart fields for a web Blob', async () => {
      const { api, fetchMock } = setup(json(utterance, 201), 'tok');
      const audio = new Blob([new Uint8Array([1, 2])], { type: 'audio/mp4' });
      const { data, response } = await api.createVoiceUtterance({
        audio,
        filename: 'two-line-sale.m4a',
        mode: 'sale',
        context: ctx,
      });
      expect(response.status).toBe(201);
      expect(data?.intent).toBe('sale');
      const req = fetchMock.mock.calls[0]![0];
      expect(req.url).toBe('https://api.example.test/v1/voice/utterances');
      expect(req.headers.get('content-type')).toMatch(/^multipart\/form-data/);
      const form = await req.formData();
      const file = form.get('audio') as File;
      expect(file.name).toBe('two-line-sale.m4a');
      expect(file.type).toBe('audio/mp4');
      expect(form.get('mode')).toBe('sale');
      expect(form.get('language')).toBe('vi');
      expect(JSON.parse(form.get('context') as string)).toEqual(ctx);
    });

    it('createVoiceUtterance passes a React Native file object through', async () => {
      const { api, fetchMock } = setup(json(utterance, 201));
      const appended: unknown[][] = [];
      const real = FormData.prototype.append;
      FormData.prototype.append = function (
        this: FormData,
        ...args: unknown[]
      ) {
        appended.push(args);
        return (real as (...a: unknown[]) => void).apply(this, [
          args[0],
          typeof args[1] === 'object' && args[1] && 'uri' in args[1]
            ? new Blob(['x'])
            : args[1],
          ...args.slice(2),
        ]);
      } as typeof real;
      try {
        await api.createVoiceUtterance({
          audio: { uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/mp4' },
          mode: 'transcribe',
          language: 'en',
          context: ctx,
        });
      } finally {
        FormData.prototype.append = real;
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(appended[0]).toEqual([
        'audio',
        { uri: 'file:///a.m4a', name: 'a.m4a', type: 'audio/mp4' },
      ]);
      expect(appended[1]).toEqual(['mode', 'transcribe']);
      expect(appended[2]).toEqual(['language', 'en']);
    });

    it.each([
      [422, 'no_speech'],
      [429, 'voice_quota'],
      [503, 'voice_unavailable'],
    ])(
      'createVoiceUtterance maps %s to the error body',
      async (status, code) => {
        const { api } = setup(json({ error: 'x', code }, status));
        const { data, error, response } = await api.createVoiceUtterance({
          audio: new Blob(['a']),
          mode: 'sale',
          context: ctx,
        });
        expect(data).toBeUndefined();
        expect(response.status).toBe(status);
        expect((error as { code?: string }).code).toBe(code);
      },
    );

    it('postVoiceOutcome sends JSON and resolves 204', async () => {
      const { api, fetchMock } = setup(new Response(null, { status: 204 }));
      const { response, error } = await api.postVoiceOutcome(utterance.id, {
        outcome: 'abandoned',
        stage: 'draft',
      });
      expect(response.status).toBe(204);
      expect(error).toBeUndefined();
      const req = fetchMock.mock.calls[0]![0];
      expect(req.url).toBe(
        `https://api.example.test/v1/voice/utterances/${utterance.id}/outcome`,
      );
      expect(await req.json()).toEqual({
        outcome: 'abandoned',
        stage: 'draft',
      });
    });
  });

  it('types: /v1/segment/points exists and product create accepts references', () => {
    type _SegmentPointsPost = paths['/v1/segment/points']['post'];
    type CreateProductBody =
      paths['/v1/products']['post']['requestBody']['content']['application/json'];
    const sample: CreateProductBody = {
      id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
      price: 10000,
      force_new: false,
      references: [
        {
          image_id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3b',
          cutout_image_id: '0192b1f0-7c1e-7a8a-9a51-2a4f0e7d1c3c',
          bbox: [0, 0, 100, 100],
        },
      ],
    };
    expect(sample).toBeDefined();
  });
});

describe('stock and receipt contract', () => {
  it('types: stock, receipt, product and scan shapes are available', () => {
    type Schemas = components['schemas'];
    const adjustment: Schemas['StockAdjustment'] = {
      count: 0,
      note: 'kiểm kho',
    };
    const delta: Schemas['StockAdjustment'] = { delta: -2 };
    const confirm: Schemas['ReceiptConfirm'] = {
      lines: [{ product_id: image.id, quantity: 24, cost: 204000 }],
      paid_with: 'cash_box',
    };
    expectTypeOf<Schemas['Product']['stock_quantity']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<Schemas['Product']['low_stock_threshold']>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<Schemas['Product']['stock_status']>().toEqualTypeOf<
      'ok' | 'low' | 'out' | 'untracked'
    >();
    expectTypeOf<Schemas['Scan']['document']>().toEqualTypeOf<
      Schemas['ScanDocument']
    >();
    expectTypeOf<
      paths['/v1/stock']['get']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<Schemas['StockList']>();
    expectTypeOf<
      paths['/v1/products/{productId}/stock-adjustments']['post']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<Schemas['StockMovement']>();
    expectTypeOf<
      paths['/v1/products/{productId}/stock-movements']['get']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<Schemas['StockMovementList']>();
    expectTypeOf<
      paths['/v1/receipts']['get']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<Schemas['ReceiptList']>();
    expectTypeOf<
      paths['/v1/receipts/{receiptId}']['get']['responses'][200]['content']['application/json']
    >().toEqualTypeOf<Schemas['Receipt']>();
    expectTypeOf<
      paths['/v1/receipts/{receiptId}']['delete']['responses'][204]
    >().not.toBeNever();
    expect(adjustment.count).toBe(0);
    expect(delta.delta).toBe(-2);
    expect(confirm.lines[0]!.cost).toBe(204000);
  });

  it('posts a receipt photo with a required idempotency header', async () => {
    const draft: components['schemas']['Receipt'] = {
      id: image.id,
      status: 'draft',
      image_id: image.id,
      image_url: image.url,
      total: 0,
      parser: 'fallback',
      model: null,
      lines: [],
      timings: { ocr: 1800, parse: 12, decisions: 0, total: 1812 },
      expense_id: null,
      created_at: '2026-10-25T00:00:00Z',
      confirmed_at: null,
    };
    const { api, fetchMock } = setup(json(draft, 201), 'tok');
    const { data, response } = await api.raw.POST('/v1/receipts', {
      params: { header: { 'Idempotency-Key': 'receipt-create-1' } },
      body: { image_id: image.id },
    });
    expect(response.status).toBe(201);
    expect(data?.status).toBe('draft');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.headers.get('Idempotency-Key')).toBe('receipt-create-1');
    expect(await req.json()).toEqual({ image_id: image.id });
  });

  it('confirms mapped lines and exposes already_confirmed errors', async () => {
    const { api, fetchMock } = setup(
      json({ error: 'Already confirmed', code: 'already_confirmed' }, 409),
      'tok',
    );
    const { error, response } = await api.raw.POST(
      '/v1/receipts/{receiptId}/confirm',
      {
        params: {
          path: { receiptId: image.id },
          header: { 'Idempotency-Key': 'receipt-confirm-1' },
        },
        body: {
          lines: [{ product_id: image.id, quantity: 24, cost: 204000 }],
          paid_with: 'other',
        },
      },
    );
    expect(response.status).toBe(409);
    expect(error?.code).toBe('already_confirmed');
    const req = fetchMock.mock.calls[0]![0];
    expect(req.url).toBe(
      `https://api.example.test/v1/receipts/${image.id}/confirm`,
    );
    expect(req.headers.get('Idempotency-Key')).toBe('receipt-confirm-1');
  });
});

describe('telemetry headers', () => {
  it.each(['session-1', null, undefined])(
    'sends session header only when provided: %s',
    async (session) => {
      const fetchMock = vi.fn(async (_req: Request) => json({ status: 'ok' }));
      const api = createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock as typeof fetch,
        getSessionId: () => session,
      });
      await api.getHealth();
      expect(
        fetchMock.mock.calls[0]![0].headers.get('X-POSTHOG-SESSION-ID'),
      ).toBe(session ?? null);
    },
  );

  it('generates fresh valid, nonzero trace and span ids per request', async () => {
    const fetchMock = vi.fn(async (_req: Request) => json({ status: 'ok' }));
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock as typeof fetch,
    });
    await api.getHealth();
    await api.getHealth();
    const headers = fetchMock.mock.calls.map(([req]) =>
      req.headers.get('traceparent')!,
    );
    for (const header of headers) {
      expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(header.split('-')[1]).not.toBe('0'.repeat(32));
      expect(header.split('-')[2]).not.toBe('0'.repeat(16));
    }
    expect(headers[0]!.split('-')[1]).not.toBe(headers[1]!.split('-')[1]);
    expect(headers[0]!.split('-')[2]).not.toBe(headers[1]!.split('-')[2]);
  });

  it('preserves a caller traceparent', async () => {
    const { api, fetchMock } = setup(json({ status: 'ok' }));
    const trace = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
    await api.raw.GET('/healthz', { headers: { traceparent: trace } });
    expect(fetchMock.mock.calls[0]![0].headers.get('traceparent')).toBe(trace);
  });
});

describe('trace id random sources', () => {
  it.each([false, true])(
    'keeps ids nonzero even when the random source returns zeros (crypto: %s)',
    async (cryptoAvailable) => {
      const originalCrypto = globalThis.crypto;
      vi.stubGlobal(
        'crypto',
        cryptoAvailable
          ? { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) }
          : undefined,
      );
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const { api, fetchMock } = setup(json({ status: 'ok' }));
        await api.getHealth();
        expect(fetchMock.mock.calls[0]![0].headers.get('traceparent')).toBe(
          '00-00000000000000000000000000000001-0000000000000001-01',
        );
        if (!cryptoAvailable) expect(random).toHaveBeenCalled();
      } finally {
        random.mockRestore();
        vi.stubGlobal('crypto', originalCrypto);
      }
    },
  );
});
