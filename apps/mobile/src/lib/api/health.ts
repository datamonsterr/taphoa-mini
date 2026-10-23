import { getApiClient } from './client';

export type HealthResponse = { status: 'ok' };

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
