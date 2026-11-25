import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { setApiTransport } from '@/lib/api';
import { createMockFetch, resetMockDb } from '@/test/mock';
import { useSettingsStore } from '@/stores/settings';
import { renderWithProviders } from '@/test/render';

import { CameraScreen } from './CameraScreen';
import { initialQuickEnroll, useQuickEnrollStore } from './quickEnroll';
import { uploadClipsAsBlobs } from '../voice/testing';
import { uploadPartsAsBlobs } from './testing';

jest.mock('./oneTrip', () => ({
  ...jest.requireActual('./oneTrip'),
  ONE_TRIP_GAP_MS: 0,
}));

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
}));

type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [];

beforeEach(() => {
  resetMockDb();
  calls = [];
  const mockFetch = createMockFetch();
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const json =
      request.method === 'POST' &&
      (path === '/v1/products' || path === '/v1/segment/points');
    calls.push({
      method: request.method,
      path,
      body: json ? await request.clone().json() : undefined,
    });
    return mockFetch(request);
  });
  useQuickEnrollStore.setState(initialQuickEnroll);
  uploadPartsAsBlobs();
  uploadClipsAsBlobs();
  mockParams = { one_trip: '1', fixture: 'product-name-price.m4a' };
});
afterEach(() => jest.restoreAllMocks());

const posts = (path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path);

async function startOneTrip() {
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByLabelText('Thêm vào kho với giá'));
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
}

it('one shutter press takes three angles, segments each at the centre and opens the sheet', async () => {
  await startOneTrip();
  await screen.findByTestId('quick-enroll-sheet');
  await waitFor(() =>
    expect(
      screen.getByRole('header', { name: 'Thêm hàng nhanh · 3/3' }),
    ).toBeOnTheScreen(),
  );
  expect(posts('/v1/images')).toHaveLength(3);
  const segments = posts('/v1/segment/points');
  expect(segments).toHaveLength(3);
  for (const { body } of segments) {
    const { points } = body as {
      points: { x: number; y: number; label: number }[];
    };
    expect(points).toHaveLength(1);
    expect(points[0]!.label).toBe(1);
  }
  // No point prompt: the seller never taps the photo.
  expect(screen.queryByTestId('point-overlay-canvas')).toBeNull();
});

it('voice fills name and price; save sends three references and logs the enrollment time', async () => {
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  await startOneTrip();
  await screen.findByRole('header', { name: 'Thêm hàng nhanh · 3/3' });
  await fireEvent.press(screen.getByRole('button', { name: 'Nói tên và giá' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Tên (không bắt buộc)')).toHaveDisplayValue(
      'Mì hảo hảo',
    ),
  );
  expect(screen.getByLabelText('Giá bán')).toHaveTextContent('5.000đ');
  await fireEvent.press(screen.getByLabelText('Lưu sản phẩm'));
  await screen.findByText('Đã thêm Mì hảo hảo');
  const [created] = posts('/v1/products');
  expect(created!.body).toMatchObject({
    name: 'Mì hảo hảo',
    price: 5000,
    references: expect.any(Array),
  });
  expect((created!.body as { references: unknown[] }).references).toHaveLength(
    3,
  );
  expect(info).toHaveBeenCalledWith(
    'enroll.one_trip_completed',
    expect.objectContaining({
      duration_ms: expect.any(Number),
      shot_count: 3,
      voice_used: true,
    }),
  );
});

it('typing still works without voice', async () => {
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  await startOneTrip();
  await screen.findByRole('header', { name: 'Thêm hàng nhanh · 3/3' });
  await fireEvent.changeText(
    screen.getByLabelText('Tên (không bắt buộc)'),
    'Kẹo',
  );
  await fireEvent.press(screen.getByRole('button', { name: '2' }));
  await fireEvent.press(screen.getByRole('button', { name: '000' }));
  await fireEvent.press(screen.getByLabelText('Lưu sản phẩm'));
  await screen.findByText('Đã thêm Kẹo');
  expect(info).toHaveBeenCalledWith(
    'enroll.one_trip_completed',
    expect.objectContaining({ shot_count: 3, voice_used: false }),
  );
});

it('without the flag the shutter keeps the point-prompt flow', async () => {
  mockParams = {};
  await startOneTrip();
  await screen.findByTestId('point-overlay-canvas');
  expect(posts('/v1/images')).toHaveLength(1);
  expect(screen.queryByTestId('quick-enroll-sheet')).toBeNull();
});

it('a clip with no speech keeps the form empty and says to type', async () => {
  mockParams = { one_trip: '1', fixture: 'no-speech.m4a' };
  await startOneTrip();
  await screen.findByRole('header', { name: 'Thêm hàng nhanh · 3/3' });
  await fireEvent.press(screen.getByRole('button', { name: 'Nói tên và giá' }));
  expect(
    await screen.findByText('Chưa nghe rõ. Nói lại hoặc gõ tay.'),
  ).toBeOnTheScreen();
  expect(screen.getByLabelText('Tên (không bắt buộc)')).toHaveDisplayValue('');
});

it('the voice button is 80 dp tall in elder mode', async () => {
  useSettingsStore.setState({ elderMode: true });
  try {
    await startOneTrip();
    const button = await screen.findByRole('button', {
      name: 'Nói tên và giá',
    });
    expect(button).toHaveStyle({ minHeight: 80 });
  } finally {
    useSettingsStore.setState({ elderMode: false });
  }
});

it('cut-outs take turns for the single inference slot and retry when it is busy', async () => {
  const mockFetch = createMockFetch();
  let inFlight = 0;
  let maxInFlight = 0;
  let busyOnce = true;
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push({ method: request.method, path });
    if (path !== '/v1/segment/points') return mockFetch(request);
    if (busyOnce) {
      busyOnce = false;
      return new Response(
        JSON.stringify({ error: { code: 'busy', message: 'segmenter busy' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await mockFetch(request);
    } finally {
      inFlight--;
    }
  });
  await startOneTrip();
  await screen.findByRole('header', { name: 'Thêm hàng nhanh · 3/3' });
  expect(maxInFlight).toBe(1);
  expect(posts('/v1/segment/points')).toHaveLength(4);
});
