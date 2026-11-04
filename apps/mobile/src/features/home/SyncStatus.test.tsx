import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native';
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
  expect(screen.getByRole('alert')).toHaveTextContent(/Thông tin chưa hợp lệ/);
  await fireEvent.press(screen.getByRole('button', { name: 'Bỏ đơn này' }));
  expect(useOutboxStore.getState().items.map((i) => i.key)).toEqual(['a']);
});

test('a server refusal shows a Vietnamese reason, not the server text', async () => {
  useOutboxStore.setState({
    items: [
      item({
        key: '0198f3a0-0000-7000-8000-000000000003',
        status: 'failed',
        error: { status: 403, message: 'permission denied' },
      }),
    ],
  });
  await view();
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(/Bạn không có quyền làm việc này/);
  expect(alert).not.toHaveTextContent(/permission denied/);
});

test('a 5xx retry says the server failed, not that the network is down', async () => {
  useOutboxStore.setState({
    items: [item({ attempts: 1, lastStatus: 500 })],
  });
  await view();
  expect(screen.getByText(/Máy chủ đang lỗi/)).toBeOnTheScreen();
  expect(screen.queryByText(/chờ gửi khi có mạng/)).toBeNull();
});

test('the cards start under the photo/grid toggle, never over it', async () => {
  await view();
  await act(async () => onlineManager.setOnline(false));
  const card = screen.getByRole('button', { name: /Mở Kho để bán/ });
  let wrap = card.parent;
  while (wrap && StyleSheet.flatten(wrap.props.style)?.top === undefined)
    wrap = wrap.parent;
  const { top } = StyleSheet.flatten(wrap!.props.style);
  // Board: the toggle ends 76 below the top inset.
  expect(top).toBeGreaterThanOrEqual(76);
});
