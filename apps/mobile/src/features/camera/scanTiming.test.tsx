import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { setAnalyticsSink } from '@/lib/analytics';
import { setApiTransport } from '@/lib/api';
import { createMockFetch, resetMockDb } from '@/test/mock';
import { renderWithProviders } from '@/test/render';

import { CameraScreen } from './CameraScreen';
import { initialQuickEnroll, useQuickEnrollStore } from './quickEnroll';
import { uploadPartsAsBlobs } from './testing';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
  useIsFocused: () => true,
}));

const events: { event: string; props: unknown }[] = [];
beforeEach(() => {
  resetMockDb();
  events.length = 0;
  setAnalyticsSink({
    capture: (event, props) => events.push({ event, props }),
  });
  useQuickEnrollStore.setState(initialQuickEnroll);
  uploadPartsAsBlobs();
});
afterEach(() => {
  setAnalyticsSink(null);
  jest.restoreAllMocks();
});

it('logs shutter-to-result latency for a scan (gate C3)', async () => {
  setApiTransport(createMockFetch());
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  await waitFor(() =>
    expect(info).toHaveBeenCalledWith('scan.tap_to_result', {
      duration_ms: expect.any(Number),
      ok: true,
      detection_count: expect.any(Number),
    }),
  );
  expect(events).toContainEqual({
    event: 'scan_tap_to_result',
    props: expect.objectContaining({ ok: true }),
  });
});

it('logs a failed scan as not ok', async () => {
  const mockFetch = createMockFetch();
  setApiTransport(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === '/v1/recognition/scans')
      return new Response(
        JSON.stringify({ error: { code: 'internal', message: 'boom' } }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    return mockFetch(request);
  });
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  await renderWithProviders(<CameraScreen />);
  await fireEvent.press(screen.getByRole('button', { name: 'Chụp' }));
  await waitFor(() =>
    expect(info).toHaveBeenCalledWith('scan.tap_to_result', {
      duration_ms: expect.any(Number),
      ok: false,
      detection_count: 0,
    }),
  );
});
