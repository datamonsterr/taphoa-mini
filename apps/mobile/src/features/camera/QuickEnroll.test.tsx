import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { Alert } from 'react-native';

import { setApiTransport } from '@/lib/api';
import { createMockFetch, getMockDb, resetMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';

import { CameraScreen } from './CameraScreen';
import {
  initialQuickEnroll,
  selectReferences,
  useQuickEnrollStore,
} from './quickEnroll';
import { uploadPartsAsBlobs } from './testing';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useIsFocused: () => true,
}));

beforeEach(() => {
  resetMockDb();
  setApiTransport(createMockFetch());
  useQuickEnrollStore.setState(initialQuickEnroll);
  uploadPartsAsBlobs();
});
afterEach(() => jest.restoreAllMocks());

async function start() {
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByLabelText('Thêm vào kho với giá'));
}
async function takeAngle() {
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  const canvas = await screen.findByTestId('point-overlay-canvas');
  await waitFor(() => expect(canvas).toBeEnabled());
  await fireEvent(canvas, 'layout', {
    nativeEvent: { layout: { width: 400, height: 800 } },
  });
  await fireEvent.press(canvas, {
    nativeEvent: { locationX: 200, locationY: 400 },
  });
  await screen.findByTestId('point-overlay-mask');
  await fireEvent.press(screen.getByLabelText('Tiếp'));
}

it('unlocks Add at exactly three accepted angles and saves three references pending then ready', async () => {
  const requests: { body: unknown; status: string | undefined }[] = [];
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const mockFetch = createMockFetch();
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body =
      request.method === 'POST' &&
      new URL(request.url).pathname === '/v1/products'
        ? await request.clone().json()
        : undefined;
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname.startsWith('/v1/products/')
    )
      await readGate;
    const response = await mockFetch(request);
    if (body)
      requests.push({
        body,
        status: (await response.clone().json()).index_status,
      });
    return response;
  });
  await start();
  await takeAngle();
  await takeAngle();
  expect(screen.queryByTestId('quick-enroll-add')).toBeNull();
  expect(screen.getByText('Xoay sản phẩm')).toBeOnTheScreen();
  await takeAngle();
  const references = selectReferences(useQuickEnrollStore.getState());
  await fireEvent.press(screen.getByLabelText('Thêm sản phẩm'));
  expect(screen.getByTestId('quick-enroll-sheet')).toBeOnTheScreen();
  expect(
    screen.getByRole('header', { name: 'Thêm hàng nhanh · 3/3' }),
  ).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Sữa mới',
  );
  await fireEvent.press(screen.getByRole('button', { name: '2' }));
  await fireEvent.press(screen.getByRole('button', { name: '000' }));
  await fireEvent.press(screen.getByLabelText('Lưu sản phẩm'));
  await screen.findByText('Đã thêm Sữa mới');
  expect(requests).toEqual([
    {
      body: expect.objectContaining({
        name: 'Sữa mới',
        price: 2000,
        references,
      }),
      status: 'pending',
    },
  ]);
  expect(references).toHaveLength(3);
  expect(useQuickEnrollStore.getState().active).toBe(false);
  expect(screen.getByText('đang học')).toBeOnTheScreen();
  await act(async () => releaseRead());
  await waitFor(() =>
    expect(
      getMockDb().products.find((p) => p.product.name === 'Sữa mới')?.product
        .index_status,
    ).toBe('ready'),
  );
  await waitFor(() => expect(screen.queryByText('đang học')).toBeNull());
});

it('keeps metadata while adding a fourth angle and allows removal down to a disabled save', async () => {
  await start();
  for (let i = 0; i < 3; i++) await takeAngle();
  await fireEvent.press(screen.getByLabelText('Thêm sản phẩm'));
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Bánh',
  );
  await fireEvent.press(screen.getByRole('button', { name: '5' }));
  await fireEvent.press(screen.getByLabelText('Thêm ảnh góc khác'));
  expect(screen.queryByTestId('quick-enroll-sheet')).toBeNull();
  await takeAngle();
  expect(screen.getByTestId('quick-enroll-sheet')).toBeOnTheScreen();
  expect(screen.getByLabelText('4 trên 8 ảnh')).toHaveTextContent('4/8');
  expect(screen.getByLabelText('Tên (không bắt buộc)')).toHaveDisplayValue(
    'Bánh',
  );
  expect(screen.getByLabelText('Giá bán')).toHaveTextContent('5đ');
  await fireEvent.press(screen.getByLabelText('Xóa ảnh 4'));
  expect(screen.getByLabelText('Lưu sản phẩm')).toBeEnabled();
  await fireEvent.press(screen.getByLabelText('Xóa ảnh 3'));
  expect(screen.getByLabelText('Lưu sản phẩm')).toBeDisabled();
});

it('retakes a shot and ignores its unfinished segment response', async () => {
  const mockFetch = createMockFetch();
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await mockFetch(request);
    if (new URL(request.url).pathname === '/v1/segment/points')
      await responseGate;
    return response;
  });
  await start();
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  const canvas = await screen.findByTestId('point-overlay-canvas');
  await waitFor(() => expect(canvas).toBeEnabled());
  await fireEvent(canvas, 'layout', {
    nativeEvent: { layout: { width: 400, height: 800 } },
  });
  await fireEvent.press(canvas, {
    nativeEvent: { locationX: 200, locationY: 400 },
  });
  await screen.findByText('Đang tách...');
  await fireEvent.press(screen.getByLabelText('Chụp lại'));
  expect(useQuickEnrollStore.getState().shots).toHaveLength(0);
  release();
  expect(screen.getByRole('button', { name: 'Chụp' })).toBeEnabled();
  expect(screen.queryByTestId('point-overlay-photo')).toBeNull();
});

it('shows a loading overlay and disables taps until the upload has an image id', async () => {
  const mockFetch = createMockFetch();
  let release!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/v1/images'
    )
      await uploadGate;
    return mockFetch(request);
  });
  await start();
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  const canvas = await screen.findByTestId('point-overlay-canvas');
  expect(canvas).toBeDisabled();
  expect(screen.getByText('Đang tải ảnh...')).toBeOnTheScreen();
  await fireEvent.press(canvas, {
    nativeEvent: { locationX: 200, locationY: 400 },
  });
  expect(useQuickEnrollStore.getState().shots[0]?.points).toEqual([]);
  release();
  await waitFor(() => expect(canvas).toBeEnabled());
});

it('resegments after undo and ignores stale point responses and failures', async () => {
  const mockFetch = createMockFetch();
  const prompts: {
    points: unknown[];
    resolve: () => void;
    reject: () => void;
  }[] = [];
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== '/v1/segment/points')
      return mockFetch(request);
    const body = await request.clone().json();
    const response = await mockFetch(request);
    await new Promise<void>((resolve, reject) =>
      prompts.push({
        points: body.points,
        resolve,
        reject: () => reject(new Error('old request failed')),
      }),
    );
    return response;
  });
  await start();
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  const canvas = await screen.findByTestId('point-overlay-canvas');
  await waitFor(() => expect(canvas).toBeEnabled());
  await fireEvent(canvas, 'layout', {
    nativeEvent: { layout: { width: 400, height: 800 } },
  });
  const tap = (x: number) =>
    fireEvent.press(canvas, { nativeEvent: { locationX: x, locationY: 400 } });
  await tap(200);
  await waitFor(() => expect(prompts).toHaveLength(1));
  await tap(220);
  await waitFor(() => expect(prompts).toHaveLength(2));
  prompts[0]!.resolve();
  expect(screen.queryByTestId('point-overlay-mask')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Hoàn tác điểm'));
  await waitFor(() => expect(prompts).toHaveLength(3));
  expect(prompts.map((p) => p.points.length)).toEqual([1, 2, 1]);
  prompts[1]!.reject();
  prompts[2]!.resolve();
  await screen.findByTestId('point-overlay-mask');
  expect(screen.queryByText('old request failed')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Hoàn tác điểm'));
  expect(screen.queryByTestId('point-overlay-mask')).toBeNull();
  expect(screen.getByLabelText('Tiếp')).toBeDisabled();
  expect(prompts).toHaveLength(3);
});

it('allows retrying segmentation after a failure', async () => {
  const mockFetch = createMockFetch();
  let fail = true;
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === '/v1/segment/points' && fail) {
      fail = false;
      throw new Error('Chưa tách được ảnh');
    }
    return mockFetch(request);
  });
  await start();
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  const canvas = await screen.findByTestId('point-overlay-canvas');
  await waitFor(() => expect(canvas).toBeEnabled());
  await fireEvent(canvas, 'layout', {
    nativeEvent: { layout: { width: 400, height: 800 } },
  });
  await fireEvent.press(canvas, {
    nativeEvent: { locationX: 200, locationY: 400 },
  });
  await screen.findByText('Chưa tách được ảnh');
  expect(screen.getByLabelText('Tiếp')).toBeDisabled();
  await fireEvent.press(canvas, {
    nativeEvent: { locationX: 210, locationY: 400 },
  });
  await screen.findByTestId('point-overlay-mask');
  expect(screen.getByLabelText('Tiếp')).toBeEnabled();
});

it('hides the camera tile at eight accepted angles', async () => {
  await start();
  for (let i = 0; i < 3; i++) await takeAngle();
  await fireEvent.press(screen.getByLabelText('Thêm sản phẩm'));
  for (let i = 3; i < 8; i++) {
    await fireEvent.press(screen.getByLabelText('Thêm ảnh góc khác'));
    await takeAngle();
  }
  expect(screen.getByLabelText('8 trên 8 ảnh')).toHaveTextContent('8/8');
  expect(screen.queryByLabelText('Thêm ảnh góc khác')).toBeNull();
});

it('retries a suspected duplicate with force_new and the same references and id', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const mockFetch = createMockFetch();
  const bodies: Record<string, unknown>[] = [];
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/v1/products'
    ) {
      bodies.push(await request.clone().json());
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            error: 'Duplicate suspected',
            code: 'duplicate_suspected',
            details: {
              candidates: [
                {
                  product_id: 'existing',
                  name: 'Sữa',
                  price: 2000,
                  similarity: 0.99,
                },
              ],
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
    }
    return mockFetch(request);
  });
  await start();
  for (let i = 0; i < 3; i++) await takeAngle();
  await fireEvent.press(screen.getByLabelText('Thêm sản phẩm'));
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Sữa khác',
  );
  await fireEvent.press(screen.getByRole('button', { name: '2' }));
  await fireEvent.press(screen.getByLabelText('Lưu sản phẩm'));
  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      'Giống "Sữa"?',
      expect.any(String),
      expect.any(Array),
    ),
  );
  const retry = alert.mock.calls[0]![2]!.find(
    (button) => button.text === 'Vẫn tạo món mới',
  );
  await act(async () => {
    retry!.onPress!();
  });
  await screen.findByText('Đã thêm Sữa khác');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ force_new: false });
  expect(bodies[1]).toEqual({ ...bodies[0], force_new: true });
  await waitFor(() => expect(screen.queryByText('đang học')).toBeNull());
});

it('shows quick enroll header in sheet and updates when removing an angle', async () => {
  await start();
  await takeAngle();
  await takeAngle();
  await takeAngle();
  await fireEvent.press(screen.getByLabelText('Thêm sản phẩm'));
  expect(screen.getByTestId('quick-enroll-sheet')).toBeOnTheScreen();
  expect(
    screen.getByRole('header', { name: 'Thêm hàng nhanh · 3/3' }),
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Xóa ảnh 3'));
  expect(
    screen.getByRole('header', { name: 'Thêm hàng nhanh · 2/3' }),
  ).toBeOnTheScreen();
});
