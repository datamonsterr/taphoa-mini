import { useSessionStore } from '@/stores/session';
import { testSession } from '@/test/session';

import { setPin, switchMember } from './auth';
import { resetApiClient, setApiTransport } from './client';
import { isApiError } from './errors';

const SELLER = '11111111-1111-4111-8111-111111111111';

const json = (status: number, body?: unknown, headers?: HeadersInit) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Call = { method: string; path: string; body: unknown };

/** One scripted answer per request; records what the app sent. */
function backend(...answers: Response[]) {
  const calls: Call[] = [];
  const transport = jest.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const text = await request.clone().text();
    calls.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : null,
    });
    return answers.shift() ?? json(500, { error: 'unscripted' });
  });
  setApiTransport(transport as unknown as typeof fetch);
  return calls;
}

const sellerSession = () => ({
  access_token: 'seller-access',
  refresh_token: 'seller-refresh',
  member: {
    id: SELLER,
    display_name: 'Bà nội',
    role: 'seller' as const,
    can_enroll: false,
    has_pin: true,
    active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
  store: testSession().store,
});

beforeEach(() => {
  useSessionStore.setState({ session: testSession(), hydrated: true });
});

afterEach(() => {
  setApiTransport(undefined);
  resetApiClient();
});

describe('switchMember', () => {
  test('without a PIN: sends only the member and stores the new session', async () => {
    const calls = backend(json(200, sellerSession()));
    await switchMember({ member_id: SELLER });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/auth/switch', body: { member_id: SELLER } },
    ]);
    const { session } = useSessionStore.getState();
    expect(session?.member.id).toBe(SELLER);
    expect(session?.access_token).toBe('seller-access');
  });

  test('with the right PIN: sends it and stores the new session', async () => {
    const calls = backend(json(200, sellerSession()));
    await switchMember({ member_id: SELLER, pin: '1234' });
    expect(calls[0]!.body).toEqual({ member_id: SELLER, pin: '1234' });
    expect(useSessionStore.getState().session?.member.display_name).toBe(
      'Bà nội',
    );
  });

  test('a wrong PIN is a 401 that keeps the old session and is not retried', async () => {
    const calls = backend(
      json(401, { error: 'missing or invalid PIN', code: 'invalid_pin' }),
    );
    const before = useSessionStore.getState().session;
    const error = await switchMember({ member_id: SELLER, pin: '0000' }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(error) && error.status).toBe(401);
    expect(isApiError(error) && error.code).toBe('invalid_pin');
    // No token refresh and no replay: a second try would count as a second wrong PIN.
    expect(calls.map((c) => c.path)).toEqual(['/v1/auth/switch']);
    expect(useSessionStore.getState().session).toBe(before);
  });

  test('a locked member is a 429 with the wait the server asked for', async () => {
    backend(
      json(
        429,
        { error: 'too many requests', code: 'rate_limited' },
        { 'retry-after': '240' },
      ),
    );
    const error = await switchMember({ member_id: SELLER, pin: '0000' }).catch(
      (e: unknown) => e,
    );
    expect(isApiError(error) && error.status).toBe(429);
    expect(isApiError(error) && error.retryAfterMs).toBe(240_000);
  });
});

describe('setPin', () => {
  test('PUT /v1/me/pin with the digits', async () => {
    const calls = backend(new Response(null, { status: 204 }));
    await setPin('4821');
    expect(calls).toEqual([
      { method: 'PUT', path: '/v1/me/pin', body: { pin: '4821' } },
    ]);
  });

  test('null clears the PIN', async () => {
    const calls = backend(new Response(null, { status: 204 }));
    await setPin(null);
    expect(calls[0]!.body).toEqual({ pin: null });
  });

  test('a rejected PIN is a 400', async () => {
    backend(
      json(400, {
        error: 'PIN must contain 4 to 6 digits',
        code: 'validation_failed',
      }),
    );
    const error = await setPin('12').catch((e: unknown) => e);
    expect(isApiError(error) && error.status).toBe(400);
  });
});
