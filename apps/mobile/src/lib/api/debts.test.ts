import { newUuid } from '@/lib/uuid';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { createTestQueryClient } from '@/test/render';
import { createMockFetch } from '@/test/mock/fetch';
import { setApiTransport } from './client';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from './debts';
import { useCreateCustomer, useCreateRepayment, useCreateSale } from './hooks';
import { keys } from './keys';

test('repayment retry reuses caller key and invalidates customers, entries, summary and reports', async () => {
  const c = await createCustomer({ id: newUuid(), name: 'Lan' });
  const transport = createMockFetch();
  const seen: string[] = [];
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const response = await transport(req);
    if (req.url.includes('/repayments')) {
      seen.push(req.headers.get('Idempotency-Key')!);
      if (seen.length === 1) throw new TypeError('response lost');
    }
    return response;
  }) as typeof fetch);
  const qc = createTestQueryClient();
  qc.setDefaultOptions({
    mutations: { retry: 1, retryDelay: 0, gcTime: Infinity },
  });
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = await renderHook(() => useCreateRepayment(c.id), {
    wrapper,
  });
  await act(async () => {
    await result.current.mutateAsync({
      amount: 1000,
      method: 'cash',
      idempotencyKey: 'stable-key',
    });
  });
  expect(seen).toEqual(['stable-key', 'stable-key']);
  expect((await getCustomer(c.id)).balance).toBe(-1000);
  for (const queryKey of [
    keys.customers.all(),
    keys.debtEntries.all(),
    keys.debtSummary(),
    keys.reports.all(),
  ]) {
    expect(invalidate).toHaveBeenCalledWith({ queryKey });
  }
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
});

test('customer update sends merge patch and client creates UUIDv7 ids', async () => {
  const transport = createMockFetch();
  const requests: Request[] = [];
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    return transport(request);
  }) as typeof fetch);
  const c = await createCustomer({ id: newUuid(), name: 'Lan' });
  expect(c.id[14]).toBe('7');
  await updateCustomer(c.id, { phone: null });
  expect(requests.at(-1)?.headers.get('content-type')).toBe(
    'application/merge-patch+json',
  );
});

test('sale mutation invalidates debt caches too', async () => {
  const qc = createTestQueryClient();
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = await renderHook(useCreateSale, { wrapper });
  const c = await createCustomer({ id: newUuid(), name: 'Lan' });
  await act(async () => {
    await result.current.mutateAsync({
      id: newUuid(),
      sold_at: new Date().toISOString(),
      total: 100,
      payment_method: 'credit',
      credit: { customer_id: c.id, amount: 100 },
      lines: [
        {
          id: newUuid(),
          product_id: null,
          source: 'manual',
          quantity: 1,
          unit_price: 100,
        },
      ],
    });
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.customers.all() });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.debtSummary() });
});

test('createCustomer sends the id the caller gives and never invents one', async () => {
  const transport = createMockFetch();
  const bodies: Record<string, unknown>[] = [];
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'POST')
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    return transport(request);
  }) as typeof fetch);
  const id = newUuid();
  await createCustomer({ id, name: 'Lan' });
  expect(bodies.at(-1)).toMatchObject({ id });
  // @ts-expect-error the id is required: a retry must resend the same one
  await expect(createCustomer({ name: 'Mai' })).rejects.toMatchObject({
    status: 400,
  });
  expect(bodies.at(-1)).not.toHaveProperty('id');
});

test('a retried customer create resends one id and makes one customer', async () => {
  const transport = createMockFetch();
  const ids: string[] = [];
  setApiTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const create =
      request.method === 'POST' && request.url.endsWith('/v1/customers');
    if (create) ids.push(((await request.clone().json()) as { id: string }).id);
    const response = await transport(request);
    if (create && ids.length === 1) throw new TypeError('response lost');
    return response;
  }) as typeof fetch);
  const qc = createTestQueryClient();
  qc.setDefaultOptions({
    mutations: { retry: 1, retryDelay: 0, gcTime: Infinity },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = await renderHook(() => useCreateCustomer(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({ name: 'Lan' });
  });
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[0]![14]).toBe('7');
  expect((await listCustomers()).items).toHaveLength(1);
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
});
