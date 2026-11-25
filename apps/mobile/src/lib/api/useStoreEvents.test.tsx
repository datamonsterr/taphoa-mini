import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useStoreEvents } from './useStoreEvents';

const mockStart = jest.fn();
const mockStop = jest.fn();
jest.mock('./eventStream', () => ({
  EventStream: jest
    .fn()
    .mockImplementation(() => ({ start: mockStart, stop: mockStop })),
}));
jest.mock('./client', () => ({
  ...jest.requireActual('./client'),
  apiBaseUrl: () => 'https://api.test',
  apiConfigured: () => true,
}));
const mockQueryClient = { invalidateQueries: jest.fn() };
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => mockQueryClient,
}));
let change: (state: AppStateStatus) => void;

test('starts only while foregrounded and stops on background or store switch', async () => {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type, listener) => {
      change = listener as (state: AppStateStatus) => void;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
  const hook = await renderHook(
    ({ store }: { store: string }) => useStoreEvents(store),
    {
      initialProps: { store: 'a' },
    },
  );
  expect(mockStart).toHaveBeenCalledTimes(1);
  await act(() => change('background'));
  expect(mockStop).toHaveBeenCalledTimes(1);
  await act(() => change('active'));
  expect(mockStart).toHaveBeenCalledTimes(2);
  await hook.rerender({ store: 'b' });
  expect(mockStop).toHaveBeenCalledTimes(2);
  expect(mockStart).toHaveBeenCalledTimes(3);
  await hook.unmount();
  expect(mockStop).toHaveBeenCalledTimes(3);
  subscription.mockRestore();
});

test('stays disconnected offline and reconnects once when online', async () => {
  const { onlineManager } = jest.requireActual<
    typeof import('@tanstack/react-query')
  >('@tanstack/react-query');
  mockStart.mockClear();
  mockStop.mockClear();
  onlineManager.setOnline(false);
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  const subscription = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type, listener) => {
      change = listener as (state: AppStateStatus) => void;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
  const hook = await renderHook(() => useStoreEvents('a'));
  expect(mockStart).not.toHaveBeenCalled();
  await act(() => onlineManager.setOnline(true));
  expect(mockStart).toHaveBeenCalledTimes(1);
  await act(() => onlineManager.setOnline(false));
  expect(mockStop).toHaveBeenCalled();
  await act(() => change('background'));
  await act(() => onlineManager.setOnline(true));
  expect(mockStart).toHaveBeenCalledTimes(1);
  await act(() => change('active'));
  expect(mockStart).toHaveBeenCalledTimes(2);
  await hook.unmount();
  subscription.mockRestore();
  onlineManager.setOnline(true);
});
