import { createApiClient } from '@taphoa/api-client';

export type HealthResponse = { status: 'ok' };

export function getApiClient() {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not configured');
  }
  return createApiClient({ baseUrl });
}

export async function getHealth(): Promise<HealthResponse> {
  const { data, response } = await getApiClient().getHealth();
  if (!response.ok) {
    throw new Error(`Health request failed: ${response.status}`);
  }
  if (data?.status !== 'ok') {
    throw new Error('Invalid health response');
  }
  return { status: data.status };
}
