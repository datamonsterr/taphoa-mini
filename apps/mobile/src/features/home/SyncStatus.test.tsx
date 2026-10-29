import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useOutboxStore, type OutboxItem } from '@/lib/outbox';

import { SyncStatus } from './SyncStatus';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};
const view = () =>
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <SyncStatus />
    </SafeAreaProvider>,
  );

const item = (over: Partial<OutboxItem>): OutboxItem => ({
  key: '0198f3a0-0000-7000-8000-000000000001',
  kind: 'sale',
  payload: {},
  storeId: null,
  createdAt: 1,
  attempts: 0,
  nextAttemptAt: 0,
  status: 'pending',
  ...over,
});

beforeEach(() => {
  onlineManager.setOnline(true);
  useOutboxStore.setState({ items: [] });
});

test('shows nothing while online with an empty outbox', async () => {
  await view();
  expect(screen.queryByRole('button')).toBeNull();
});

test('offline: hints at the grid and the hint opens it', async () => {
  await view();
  await act(async () => onlineManager.setOnline(false));
  await fireEvent.press(screen.getByRole('button', { name: /Mở Kho để bán/ }));
  expect(router.push).toHaveBeenCalledWith('/inventory');
});

test('counts unsent sales and offers discard for a refused one', async () => {
  useOutboxStore.setState({
    items: [
      item({ key: 'a', status: 'pending' }),
      item({
        key: '0198f3a0-0000-7000-8000-000000000002',
        status: 'failed',
        error: { status: 400, message: 'Tổng tiền sai' },
      }),
    ],
  });
  await view();
  expect(screen.getByText('1 đơn chờ gửi khi có mạng')).toBeOnTheScreen();
  expect(screen.getByRole('alert')).toHaveTextContent(/Tổng tiền sai/);
  await fireEvent.press(screen.getByRole('button', { name: 'Bỏ đơn này' }));
  expect(useOutboxStore.getState().items.map((i) => i.key)).toEqual(['a']);
});
