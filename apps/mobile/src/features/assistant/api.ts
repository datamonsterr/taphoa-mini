import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { components } from '@taphoa/api-client';

import { capture } from '@/lib/analytics';
import { getApiClient } from '@/lib/api/client';
import { isApiError, unwrap } from '@/lib/api/errors';
import { keys } from '@/lib/api/keys';

type Schemas = components['schemas'];
export type AssistantThreadDetail = Schemas['AssistantThreadDetail'];
export type CreateAssistantThreadInput = Schemas['CreateAssistantThread'];

export type NextStepsParams = {
  screen: string;
  documentDetected?: boolean;
  unknownProduct?: boolean;
};

/** Query keys of the assistant. All start with `api` so a mode reset clears them too. */
export const assistantKeys = {
  all: () => [...keys.all, 'assistant'] as const,
  threads: () => [...assistantKeys.all(), 'threads'] as const,
  thread: (threadId: string) =>
    [...assistantKeys.all(), 'thread', threadId] as const,
  threadDetails: () => [...assistantKeys.all(), 'thread'] as const,
  nextSteps: (params: NextStepsParams) =>
    [...assistantKeys.all(), 'next-steps', params] as const,
};

/** The caller's threads, newest first, flattened across cursor pages. */
export const useAssistantThreads = () =>
  useInfiniteQuery({
    queryKey: assistantKeys.threads(),
    queryFn: ({ pageParam }) =>
      unwrap(
        getApiClient().raw.GET('/v1/assistant/threads', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    select: (data) => data.pages.flatMap((page) => page.items),
  });

/** One thread with its messages and actions; disabled while `threadId` is undefined. */
export const useAssistantThread = (threadId: string | undefined) =>
  useQuery({
    queryKey: assistantKeys.thread(threadId ?? ''),
    queryFn: () =>
      unwrap(
        getApiClient().raw.GET('/v1/assistant/threads/{threadId}', {
          params: { path: { threadId: threadId! } },
        }),
      ),
    enabled: Boolean(threadId),
    // Turns change the stored thread behind this key's back: every mount reads it again, and the
    // chat hydrates only from data fetched after mount (`isFetchedAfterMount`).
    refetchOnMount: 'always',
  });

export const useCreateAssistantThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAssistantThreadInput) =>
      unwrap(getApiClient().raw.POST('/v1/assistant/threads', { body })),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assistantKeys.threads() }),
  });
};

export const useDeleteAssistantThread = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      unwrap(
        getApiClient().raw.DELETE('/v1/assistant/threads/{threadId}', {
          params: { path: { threadId } },
        }),
      ),
    onSuccess: (_data, threadId) => {
      queryClient.removeQueries({ queryKey: assistantKeys.thread(threadId) });
      return queryClient.invalidateQueries({
        queryKey: assistantKeys.threads(),
      });
    },
  });
};

/** Replaces the decided action inside the cached thread it belongs to. */
function applyAction(
  queryClient: QueryClient,
  action: components['schemas']['AssistantAction'],
) {
  queryClient.setQueryData<AssistantThreadDetail>(
    assistantKeys.thread(action.thread_id),
    (detail) =>
      detail && {
        ...detail,
        actions: detail.actions.map((a) => (a.id === action.id ? action : a)),
      },
  );
}

/** A decision the server already holds: refetch so the card shows the real state. */
function refetchIfDecided(queryClient: QueryClient, error: unknown) {
  if (isApiError(error) && error.code === 'already_decided')
    void queryClient.invalidateQueries({
      queryKey: assistantKeys.threadDetails(),
    });
}

/** The action id is the idempotency key, so a retried confirm replays the first result. */
export const useConfirmAssistantAction = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actionId: string) =>
      unwrap(
        getApiClient().raw.POST('/v1/assistant/actions/{actionId}/confirm', {
          params: {
            path: { actionId },
            header: { 'Idempotency-Key': actionId },
          },
        }),
      ),
    onSuccess: (action) => applyAction(queryClient, action),
    onError: (error) => refetchIfDecided(queryClient, error),
  });
};

export const useRejectAssistantAction = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (actionId: string) =>
      unwrap(
        getApiClient().raw.POST('/v1/assistant/actions/{actionId}/reject', {
          params: { path: { actionId } },
        }),
      ),
    onSuccess: (action) => applyAction(queryClient, action),
    onError: (error) => refetchIfDecided(queryClient, error),
  });
};

export const useAssistantFeedback = () =>
  useMutation({
    mutationFn: (input: {
      messageId: string;
      rating: 'up' | 'down';
      comment?: string;
    }) =>
      unwrap(
        getApiClient().raw.POST('/v1/assistant/messages/{messageId}/feedback', {
          params: { path: { messageId: input.messageId } },
          body: {
            rating: input.rating,
            ...(input.comment ? { comment: input.comment } : {}),
          },
        }),
      ),
    onSuccess: (_data, input) =>
      capture('assistant_feedback_given', { rating: input.rating }),
  });

/** Ranked next-step chips for a screen. */
export const useNextSteps = (
  params: NextStepsParams,
  { enabled }: { enabled: boolean },
) =>
  useQuery({
    queryKey: assistantKeys.nextSteps(params),
    queryFn: () =>
      unwrap(
        getApiClient().raw.GET('/v1/assistant/next-steps', {
          params: {
            query: {
              screen: params.screen,
              ...(params.documentDetected === undefined
                ? {}
                : { document_detected: params.documentDetected }),
              ...(params.unknownProduct === undefined
                ? {}
                : { unknown_product: params.unknownProduct }),
            },
          },
        }),
      ),
    enabled,
    // A flipped flag changes the key: keep the old chips on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
