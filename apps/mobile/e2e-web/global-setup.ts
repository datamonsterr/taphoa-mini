/**
 * Fails the whole run up front, with the fix in the message, when the real backend is down
 * (instead of every spec timing out on a failed request).
 */
export default async function globalSetup() {
  const api = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
  const url = `${api.replace(/\/$/, '')}/readyz`;
  let problem: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (response.status === 200) return;
    problem = `HTTP ${response.status}`;
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `Backend not ready at ${url} (${problem}).\n` +
      'The web e2e suite needs the real backend with recognition models. Start it with:\n' +
      '  scripts/e2e/stack.sh up\n' +
      'and stop it with `scripts/e2e/stack.sh down`. Set EXPO_PUBLIC_API_URL when the backend ' +
      'is not on http://localhost:8080.',
  );
}
