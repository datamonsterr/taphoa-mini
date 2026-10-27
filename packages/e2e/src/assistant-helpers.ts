import type { ApiClient, components } from '@taphoa/api-client';
import { expect } from 'vitest';
import { assertErrorResponse } from './helpers.js';

export type Thread = components['schemas']['AssistantThread'];

export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createThread(client: ApiClient): Promise<Thread> {
  const result = await client.raw.POST('/v1/assistant/threads', {
    body: { title: 'E2E assistant', context: { screen: 'camera' } },
  });
  expect(result.response.status, JSON.stringify(result.error)).toBe(201);
  expect(result.data!.id).toMatch(uuid);
  return result.data!;
}

export function jsonError(response: Response, error: unknown, status: number) {
  expect(response.status, JSON.stringify(error)).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  assertErrorResponse(error);
}
