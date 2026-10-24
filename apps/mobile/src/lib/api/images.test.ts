import { resetApiClient, setApiTransport } from './client';
import { BUSY_RETRY_DELAY_MS, createScan } from './images';

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const busy = (headers: HeadersInit = {}) =>
  json(503, { error: 'segmenter busy', code: 'unavailable' }, headers);
const noModel = () =>
  json(503, { error: 'no model loaded', code: 'unavailable' });
const scan = { id: 'scan-1', detections: [] };

const bodies: string[] = [];
const transportOf = (...responses: (() => Response)[]) => {
  bodies.length = 0;
  const queue = [...responses];
  const fn = jest.fn(async (req: Request) => {
    bodies.push(String((await req.formData()).get('image_id')));
    return queue.shift()!();
  });
  setApiTransport(fn as unknown as typeof fetch);
  return fn;
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  setApiTransport();
  resetApiClient();
});

const run = async (promise: Promise<unknown>) => {
  const settled = promise.then(
    (v) => ({ v }),
    (e: unknown) => ({ e }),
  );
  await jest.advanceTimersByTimeAsync(10_000);
  return settled;
};

describe('createScan busy retry', () => {
  test('retries once after ~500 ms on segmenter busy and reuses the image id', async () => {
    const t = transportOf(
      () => busy(),
      () => json(200, scan),
    );
    const p = createScan({ image_id: 'img-1' });
    await jest.advanceTimersByTimeAsync(BUSY_RETRY_DELAY_MS - 1);
    expect(t).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ id: 'scan-1' });
    expect(t).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual(['img-1', 'img-1']);
  });

  test('honours Retry-After', async () => {
    const t = transportOf(
      () => busy({ 'Retry-After': '1' }),
      () => json(200, scan),
    );
    const p = createScan({ image_id: 'img-1' });
    await jest.advanceTimersByTimeAsync(999);
    expect(t).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ id: 'scan-1' });
    expect(t).toHaveBeenCalledTimes(2);
  });

  test('gives up after one retry', async () => {
    const t = transportOf(
      () => busy(),
      () => busy(),
      () => json(200, scan),
    );
    const result = await run(createScan({ image_id: 'img-1' }));
    expect(result).toMatchObject({ e: { status: 503 } });
    expect(t).toHaveBeenCalledTimes(2);
  });

  test('does not retry "no model loaded" 503', async () => {
    const t = transportOf(noModel, () => json(200, scan));
    const result = await run(createScan({ image_id: 'img-1' }));
    expect(result).toMatchObject({ e: { status: 503 } });
    expect(t).toHaveBeenCalledTimes(1);
  });

  test('does not retry other errors', async () => {
    const t = transportOf(
      () => json(429, { error: 'slow down' }, { 'Retry-After': '1' }),
      () => json(200, scan),
    );
    const result = await run(createScan({ image_id: 'img-1' }));
    expect(result).toMatchObject({ e: { status: 429 } });
    expect(t).toHaveBeenCalledTimes(1);
  });
});
