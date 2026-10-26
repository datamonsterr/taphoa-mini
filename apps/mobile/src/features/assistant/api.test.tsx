import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { setAnalyticsSink } from '@/lib/analytics';
import { ApiError } from '@/lib/api/errors';
import { createTestQueryClient } from '@/test/render';
import { proposalReply, setNextAssistantReply } from '@/test/mock';
import { getApiClient } from '@/lib/api/client';
import { newUuid } from '@/lib/uuid';

import {
  assistantKeys,
  useAssistantFeedback,
  useAssistantThread,
  useAssistantThreads,
  useConfirmAssistantAction,
  useCreateAssistantThread,
  useDeleteAssistantThread,
  useNextSteps,
  useRejectAssistantAction,
} from './api';

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let value!: T;
  await act(async () => {
    value = await fn();
  });
  return value;
}

afterEach(() => setAnalyticsSink(null));

/** Creates a thread and plays the proposal reply so it holds one proposed action. */
async function threadWithAction() {
  const client = getApiClient();
  const created = await client.raw.POST('/v1/assistant/threads', { body: {} });
  const threadId = created.data!.id;
  setNextAssistantReply(proposalReply());
  const sent = await client.sendAssistantMessage(threadId, {
    content: 'nhập mì',
    language: 'vi',
  });
  for await (const _event of sent.events!) void _event;
  const detail = await client.raw.GET('/v1/assistant/threads/{threadId}', {
    params: { path: { threadId } },
  });
  return { threadId, action: detail.data!.actions[0] };
}

test('keys share the api prefix', () => {
  expect(assistantKeys.threads().slice(0, 2)).toEqual(['api', 'assistant']);
  expect(assistantKeys.thread('t')).toContain('t');
});

test('creates, lists, reads and deletes threads', async () => {
  const { wrapper, queryClient } = setup();
  const list = await renderHook(() => useAssistantThreads(), { wrapper });
  await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
  expect(list.result.current.data).toEqual([]);

  const create = await renderHook(() => useCreateAssistantThread(), {
    wrapper,
  });
  const thread = await run(() =>
    create.result.current.mutateAsync({
      title: 'Doanh thu',
      context: { screen: 'camera' },
    }),
  );
  expect(thread.title).toBe('Doanh thu');
  await waitFor(() => expect(list.result.current.data).toHaveLength(1));

  const detail = await renderHook(() => useAssistantThread(thread.id), {
    wrapper,
  });
  await waitFor(() =>
    expect(detail.result.current.data?.thread.id).toBe(thread.id),
  );

  const del = await renderHook(() => useDeleteAssistantThread(), { wrapper });
  await run(() => del.result.current.mutateAsync(thread.id));
  await waitFor(() => expect(list.result.current.data).toEqual([]));
  expect(queryClient.getQueryData(assistantKeys.thread(thread.id))).toBe(
    undefined,
  );
});

test('thread query is disabled without an id and errors are ApiErrors', async () => {
  const { wrapper } = setup();
  const idle = await renderHook(() => useAssistantThread(undefined), {
    wrapper,
  });
  expect(idle.result.current.fetchStatus).toBe('idle');
  const missingId = newUuid();
  const missing = await renderHook(() => useAssistantThread(missingId), {
    wrapper,
  });
  await waitFor(() => expect(missing.result.current.isError).toBe(true));
  expect(missing.result.current.error).toBeInstanceOf(ApiError);
});

test('lists further pages by cursor', async () => {
  const { wrapper } = setup();
  const client = getApiClient();
  for (let i = 0; i < 3; i++)
    await client.raw.POST('/v1/assistant/threads', { body: {} });
  const list = await renderHook(() => useAssistantThreads(), { wrapper });
  await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
  expect(list.result.current.data).toHaveLength(3);
  expect(list.result.current.hasNextPage).toBe(false);
});

test('confirm sends the action id as Idempotency-Key and updates the thread cache', async () => {
  const { wrapper, queryClient } = setup();
  const { threadId, action } = await threadWithAction();
  const detail = await renderHook(() => useAssistantThread(threadId), {
    wrapper,
  });
  await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
  const spy = jest.spyOn(getApiClient().raw, 'POST');
  const confirm = await renderHook(() => useConfirmAssistantAction(), {
    wrapper,
  });
  const done = await run(() => confirm.result.current.mutateAsync(action.id));
  expect(done.status).toBe('done');
  expect(spy).toHaveBeenCalledWith(
    '/v1/assistant/actions/{actionId}/confirm',
    expect.objectContaining({
      params: {
        path: { actionId: action.id },
        header: { 'Idempotency-Key': action.id },
      },
    }),
  );
  const cached = queryClient.getQueryData<{
    actions: { id: string; status: string }[];
  }>(assistantKeys.thread(threadId));
  expect(cached?.actions[0].status).toBe('done');
  spy.mockRestore();
});

test('confirming twice is a stale 409 ApiError, which refetches threads', async () => {
  const { wrapper } = setup();
  const { action } = await threadWithAction();
  const confirm = await renderHook(() => useConfirmAssistantAction(), {
    wrapper,
  });
  await run(() => confirm.result.current.mutateAsync(action.id));
  const error = await run(() =>
    confirm.result.current.mutateAsync(action.id).catch((e: unknown) => e),
  );
  // Same key replays the first result in the mock.
  expect(error).not.toBeInstanceOf(ApiError);
  const reject = await renderHook(() => useRejectAssistantAction(), {
    wrapper,
  });
  const failure = await run(() =>
    reject.result.current.mutateAsync(action.id).catch((e: unknown) => e),
  );
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).code).toBe('already_decided');
});

test('reject marks the action rejected', async () => {
  const { wrapper } = setup();
  const { action } = await threadWithAction();
  const reject = await renderHook(() => useRejectAssistantAction(), {
    wrapper,
  });
  const result = await run(() => reject.result.current.mutateAsync(action.id));
  expect(result.status).toBe('rejected');
});

test('feedback posts the rating and captures the event', async () => {
  const sink = { capture: jest.fn() };
  setAnalyticsSink(sink);
  const { wrapper } = setup();
  const { threadId } = await threadWithAction();
  const detail = await getApiClient().raw.GET(
    '/v1/assistant/threads/{threadId}',
    { params: { path: { threadId } } },
  );
  const messageId = detail.data!.messages.find(
    (m) => m.role === 'assistant',
  )!.id;
  const feedback = await renderHook(() => useAssistantFeedback(), { wrapper });
  await run(() =>
    feedback.result.current.mutateAsync({ messageId, rating: 'up' }),
  );
  expect(sink.capture).toHaveBeenCalledWith('assistant_feedback_given', {
    rating: 'up',
  });
  const failed = await run(() =>
    feedback.result.current
      .mutateAsync({ messageId: newUuid(), rating: 'down' })
      .catch((e: unknown) => e),
  );
  expect(failed).toBeInstanceOf(ApiError);
  expect(sink.capture).toHaveBeenCalledTimes(1);
});

test('next steps query honours enabled and passes the flags', async () => {
  const { wrapper } = setup();
  const off = await renderHook(
    () => useNextSteps({ screen: 'camera' }, { enabled: false }),
    { wrapper },
  );
  expect(off.result.current.fetchStatus).toBe('idle');
  const on = await renderHook(
    () =>
      useNextSteps(
        { screen: 'camera', documentDetected: true, unknownProduct: false },
        { enabled: true },
      ),
    { wrapper },
  );
  await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
  expect(on.result.current.data?.items.length).toBeGreaterThan(0);
});

test('next steps keep showing the previous chips while a changed flag refetches', async () => {
  const { wrapper } = setup();
  const hook = await renderHook(
    (props: { documentDetected: boolean }) =>
      useNextSteps(
        { screen: 'camera', documentDetected: props.documentDetected },
        { enabled: true },
      ),
    { wrapper, initialProps: { documentDetected: false } },
  );
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  const before = hook.result.current.data;
  await hook.rerender({ documentDetected: true });
  // No render in between shows an empty list: the old chips stay until the new ones arrive.
  expect(hook.result.current.data).toBe(before);
  expect(hook.result.current.isPlaceholderData).toBe(true);
  await waitFor(() =>
    expect(hook.result.current.isPlaceholderData).toBe(false),
  );
  expect(hook.result.current.data?.items.length).toBeGreaterThan(0);
});
