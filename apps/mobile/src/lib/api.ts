export type HealthResponse = { status: 'ok' };

export async function getHealth(): Promise<HealthResponse> {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is not configured');
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`);
  if (!response.ok) {
    throw new Error(`Health request failed: ${response.status}`);
  }

  const data: unknown = await response.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !('status' in data) ||
    data.status !== 'ok'
  ) {
    throw new Error('Invalid health response');
  }
  return { status: data.status };
}
