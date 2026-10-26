import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import type { Sale } from '@/lib/api';
import * as ledger from '@/lib/api/ledger';
import { resetMockDb } from '@/test/mock';
import { createTestQueryClient } from '@/test/render';

import { currentRange, useDashboardData } from './useDashboardData';

describe('currentRange', () => {
  // 2026-10-23 is a Friday
  const now = new Date('2026-10-23T05:00:00Z');
  test('day is today', () => {
    expect(currentRange('day', now)).toEqual({
      from: '2026-10-23',
      to: '2026-10-23',
    });
  });
  test('week starts on Monday', () => {
    expect(currentRange('week', now)).toEqual({
      from: '2026-10-19',
      to: '2026-10-23',
    });
  });
  test('month starts on the 1st', () => {
    expect(currentRange('month', now)).toEqual({
      from: '2026-10-01',
      to: '2026-10-23',
    });
  });
});
describe('useDashboardData', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: createTestQueryClient() },
      children,
    );
  const sale = (
    id: string,
    method: Sale['payment_method'],
    total: number,
    credit_amount = 0,
  ) => ({ id, payment_method: method, total, credit_amount }) as Sale;

  beforeEach(() => resetMockDb());
  afterEach(() => jest.restoreAllMocks());

  test('week totals page through every sale, not just the first 200', async () => {
    const list = jest
      .spyOn(ledger, 'listSales')
      .mockResolvedValueOnce({
        items: [sale('a', 'cash', 1000), sale('b', 'transfer', 2000)],
        next_cursor: 'c2',
      })
      .mockResolvedValueOnce({
        items: [sale('c', 'cash', 4000)],
        next_cursor: 'c3',
      })
      .mockResolvedValueOnce({
        items: [sale('d', 'transfer', 8000)],
        next_cursor: null,
      });
    const { result } = await renderHook(() => useDashboardData('week'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(list.mock.calls.map(([params]) => params?.cursor ?? null)).toEqual([
      null,
      'c2',
      'c3',
    ]);
    const ready = result.current as Extract<
      typeof result.current,
      { status: 'ready' }
    >;
    expect(ready.totals.cash).toBe(5000);
    expect(ready.totals.transfer).toBe(10000);
  });

  test('week cash and transfer count only the paid part of credit sales', async () => {
    jest.spyOn(ledger, 'listSales').mockResolvedValue({
      items: [
        sale('a', 'cash', 100000, 60000),
        sale('b', 'transfer', 50000, 20000),
        sale('c', 'credit', 30000, 30000),
        sale('d', 'cash', 5000),
      ],
      next_cursor: null,
    });
    const { result } = await renderHook(() => useDashboardData('week'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const ready = result.current as Extract<
      typeof result.current,
      { status: 'ready' }
    >;
    expect(ready.totals.cash).toBe(45000);
    expect(ready.totals.transfer).toBe(30000);
  });

  test('day mode does not query sales at all', async () => {
    const list = jest.spyOn(ledger, 'listSales');
    const { result } = await renderHook(() => useDashboardData('day'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(list).not.toHaveBeenCalled();
  });

  test('ranges follow the date after midnight', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
        'nextTick',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    jest.setSystemTime(new Date('2026-10-23T12:00:00+07:00'));
    const list = jest.spyOn(ledger, 'listSales').mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    const { result, rerender } = await renderHook(
      () => useDashboardData('week'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(list.mock.calls.at(-1)![0]).toMatchObject({ to: '2026-10-23' });
    jest.setSystemTime(new Date('2026-10-24T00:30:00+07:00'));
    await rerender({});
    await waitFor(() =>
      expect(list.mock.calls.at(-1)![0]).toMatchObject({ to: '2026-10-24' }),
    );
  });
});
