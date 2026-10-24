import { setApiTransport } from '@/lib/api';
import { useSessionStore, SESSION_STORAGE_KEY } from '@/stores/session';
import { testSession } from '@/test/session';
import { fireEvent, renderApp, screen, waitFor } from '@/test/router';

const secureValues = (
  jest.requireMock('expo-secure-store') as { __values: Map<string, string> }
).__values;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Sent = {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
};

/** A scripted backend. `answers` maps "METHOD /path" to a response; the rest answers 404. */
function backend(answers: Record<string, () => Response>) {
  const sent: Sent[] = [];
  const transport = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    const text = await request.clone().text();
    sent.push({
      method: request.method,
      path,
      body: text ? JSON.parse(text) : undefined,
      auth: request.headers.get('authorization'),
    });
    const answer = answers[`${request.method} ${path}`];
    return answer ? answer() : json(404, { error: 'not found' });
  }) as typeof fetch;
  setApiTransport(transport);
  return sent;
}

const signedOut = () =>
  useSessionStore.setState({
    session: null,
    hydrated: true,
    pendingRecoveryCode: null,
  });

const authBody = (extra: object = {}) => {
  const { member, store } = testSession();
  return {
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    expires_in: 900,
    member,
    store,
    ...extra,
  };
};

const type = (label: string, text: string) =>
  fireEvent.changeText(screen.getByLabelText(label), text);

beforeEach(() => {
  secureValues.clear();
  signedOut();
});

test('without a session the app opens on the welcome screen, never on the camera', async () => {
  backend({});
  await renderApp('/');
  expect(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Tham gia cửa hàng' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Khôi phục cửa hàng' }),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-screen')).toBeNull();
});

test('with a session the app opens on the camera', async () => {
  useSessionStore.setState({ session: testSession(), hydrated: true });
  await renderApp('/');
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
});

test('create store: sends the form, shows the recovery code once, then opens the camera', async () => {
  const sent = backend({
    'POST /v1/stores': () =>
      json(201, authBody({ recovery_code: '7KQ4-MZ2P-9HXD-T3VA' })),
  });
  await renderApp('/');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  );
  await type('Tên cửa hàng', '  Tạp hóa Cô Ba ');
  await type('Tên của bạn', 'Mẹ');
  await fireEvent.press(screen.getByRole('button', { name: 'Tạo cửa hàng' }));

  expect(await screen.findByText('7KQ4-MZ2P-9HXD-T3VA')).toBeOnTheScreen();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: 'POST',
    path: '/v1/stores',
    auth: null,
    body: {
      store_name: 'Tạp hóa Cô Ba',
      display_name: 'Mẹ',
      device: { platform: 'ios' },
    },
  });
  // The session is saved already, but the person has not confirmed the code yet.
  expect(screen.queryByTestId('camera-screen')).toBeNull();
  expect(JSON.parse(secureValues.get(SESSION_STORAGE_KEY)!)).toMatchObject({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
  });
  expect(secureValues.get(SESSION_STORAGE_KEY)).not.toContain('7KQ4');

  await fireEvent.press(screen.getByRole('button', { name: 'Tiếp tục' }));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
  expect(useSessionStore.getState().pendingRecoveryCode).toBeNull();
});

test('create store: validates the fields before calling the server', async () => {
  const sent = backend({});
  await renderApp('/create');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  );
  expect(
    screen.getByText('Nhập tên cửa hàng (tối đa 80 ký tự)'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
  ).toBeOnTheScreen();
  expect(sent).toHaveLength(0);
});

test.each([
  [
    json(400, { error: 'bad', code: 'validation_failed' }),
    'Thông tin chưa hợp lệ.',
  ],
  [
    json(429, { error: 'slow down' }),
    'Thử quá nhiều lần. Đợi một lúc rồi thử lại.',
  ],
  [json(503, { error: 'down' }), 'Máy chủ đang bận. Thử lại sau.'],
])(
  'create store: a failed call keeps the form and says why (%#)',
  async (response, message) => {
    backend({ 'POST /v1/stores': () => response });
    await renderApp('/create');
    await type('Tên cửa hàng', 'Tạp hóa');
    await type('Tên của bạn', 'Mẹ');
    await fireEvent.press(
      await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
    );
    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(useSessionStore.getState().session).toBeNull();
    // Retrying is possible: the button is enabled again.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Tạo cửa hàng' }),
      ).toBeEnabled(),
    );
  },
);

test('create store: an unreachable server shows the network message', async () => {
  setApiTransport((async () => {
    throw new TypeError('Network request failed');
  }) as typeof fetch);
  await renderApp('/create');
  await type('Tên cửa hàng', 'Tạp hóa');
  await type('Tên của bạn', 'Mẹ');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  );
  expect(
    await screen.findByText(
      'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
    ),
  ).toBeOnTheScreen();
});

test('join: a typed invite code (spaces, lower case) signs the member in and opens the camera', async () => {
  const sent = backend({ 'POST /v1/auth/join': () => json(201, authBody()) });
  await renderApp('/join');
  await type('Mã mời', 'k7q4 mz2p 9hxd t3va');
  await type('Tên của bạn', 'Bà nội');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tham gia' }),
  );

  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
  expect(sent[0]).toMatchObject({
    path: '/v1/auth/join',
    auth: null,
    body: { invite_token: 'K7Q4MZ2P9HXDT3VA', display_name: 'Bà nội' },
  });
  expect(useSessionStore.getState().session?.access_token).toBe('access-new');
});

test('join: accepts a pasted taphoa:// link', async () => {
  const sent = backend({ 'POST /v1/auth/join': () => json(201, authBody()) });
  await renderApp('/join');
  await type('Mã mời', 'taphoa://join?token=K7Q4MZ2P9HXDT3VA');
  await type('Tên của bạn', 'Bà nội');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tham gia' }),
  );
  await screen.findByTestId('camera-screen');
  expect(sent[0]!.body).toMatchObject({ invite_token: 'K7Q4MZ2P9HXDT3VA' });
});

test('join: an expired or used invite is reported (410) and the form stays', async () => {
  backend({
    'POST /v1/auth/join': () =>
      json(410, { error: 'invite expired', code: 'invite_unavailable' }),
  });
  await renderApp('/join');
  await type('Mã mời', 'OLDCODE');
  await type('Tên của bạn', 'Bà nội');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tham gia' }),
  );
  expect(
    await screen.findByText('Mã mời đã hết hạn hoặc đã được dùng.'),
  ).toBeOnTheScreen();
  expect(useSessionStore.getState().session).toBeNull();
});

test('join: asks for both fields', async () => {
  const sent = backend({});
  await renderApp('/join');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Tham gia' }),
  );
  expect(screen.getByText('Nhập mã mời')).toBeOnTheScreen();
  expect(
    screen.getByText('Nhập tên của bạn (tối đa 40 ký tự)'),
  ).toBeOnTheScreen();
  expect(sent).toHaveLength(0);
});

test('recover: signs the Lead in and shows the rotated recovery code', async () => {
  const sent = backend({
    'POST /v1/auth/recover': () =>
      json(200, authBody({ recovery_code: 'NEW1-NEW2-NEW3-NEW4' })),
  });
  await renderApp('/recover');
  await type('Mã khôi phục', '7kq4-mz2p-9hxd-t3va');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Khôi phục' }),
  );

  expect(await screen.findByText('NEW1-NEW2-NEW3-NEW4')).toBeOnTheScreen();
  expect(sent[0]).toMatchObject({
    path: '/v1/auth/recover',
    body: { recovery_code: '7kq4-mz2p-9hxd-t3va', device: { platform: 'ios' } },
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Tiếp tục' }));
  expect(await screen.findByTestId('camera-screen')).toBeOnTheScreen();
});

test('recover: a wrong code (401) is reported', async () => {
  backend({
    'POST /v1/auth/recover': () => json(401, { error: 'unauthorized' }),
  });
  await renderApp('/recover');
  await type('Mã khôi phục', 'WRONG');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Khôi phục' }),
  );
  expect(await screen.findByText('Mã khôi phục không đúng.')).toBeOnTheScreen();
  expect(useSessionStore.getState().session).toBeNull();
});

test('recover: asks for the code', async () => {
  const sent = backend({});
  await renderApp('/recover');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Khôi phục' }),
  );
  expect(screen.getByText('Nhập mã khôi phục')).toBeOnTheScreen();
  expect(sent).toHaveLength(0);
});

test('the recovery-code screen without a pending code goes back to the welcome screen', async () => {
  backend({});
  await renderApp('/recovery-code');
  expect(
    await screen.findByRole('button', { name: 'Khôi phục cửa hàng' }),
  ).toBeOnTheScreen();
});

test('sign out: revokes the session on the server, clears it and returns to onboarding', async () => {
  useSessionStore.setState({ session: testSession(), hydrated: true });
  secureValues.set(SESSION_STORAGE_KEY, JSON.stringify(testSession()));
  const sent = backend({
    'GET /v1/me': () =>
      json(200, { member: testSession().member, store: testSession().store }),
    'GET /v1/store': () => json(200, testSession().store),
    'GET /v1/members': () => json(200, { items: [testSession().member] }),
    'POST /v1/auth/logout': () => json(204),
  });
  await renderApp('/account');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Đăng xuất' }),
  );

  expect(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  ).toBeOnTheScreen();
  const logout = sent.find((call) => call.path === '/v1/auth/logout')!;
  expect(logout).toMatchObject({
    method: 'POST',
    auth: 'Bearer test-access-token',
  });
  expect(useSessionStore.getState().session).toBeNull();
  expect(secureValues.has(SESSION_STORAGE_KEY)).toBe(false);
});

test('sign out still signs out locally when the server cannot be reached', async () => {
  useSessionStore.setState({ session: testSession(), hydrated: true });
  setApiTransport((async (input: RequestInfo | URL) => {
    const path = new URL((input as Request).url).pathname;
    if (path === '/v1/auth/logout') throw new TypeError('offline');
    if (path === '/v1/me')
      return json(200, {
        member: testSession().member,
        store: testSession().store,
      });
    if (path === '/v1/members')
      return json(200, { items: [testSession().member] });
    if (path === '/v1/store') return json(200, testSession().store);
    return json(200, { items: [], next_cursor: null });
  }) as typeof fetch);
  await renderApp('/account');
  await fireEvent.press(
    await screen.findByRole('button', { name: 'Đăng xuất' }),
  );
  expect(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  ).toBeOnTheScreen();
  expect(useSessionStore.getState().session).toBeNull();
});

test('a refused refresh signs the app out: the next 401 routes to onboarding', async () => {
  useSessionStore.setState({ session: testSession(), hydrated: true });
  backend({
    'GET /v1/me': () => json(401, { error: 'expired' }),
    'GET /v1/store': () => json(401, { error: 'expired' }),
    'GET /v1/members': () => json(401, { error: 'expired' }),
    'POST /v1/auth/refresh': () => json(401, { error: 'revoked' }),
  });
  await renderApp('/account');
  expect(
    await screen.findByRole('button', { name: 'Tạo cửa hàng' }),
  ).toBeOnTheScreen();
  expect(useSessionStore.getState().session).toBeNull();
});
