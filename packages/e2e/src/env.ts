/**
 * Reads and validates the BACKEND_URL environment variable.
 * Default is supplied for `test:e2e` via vitest configuration;
 * throws if unset in other execution contexts.
 */
export function getBackendUrl(): string {
  const url = process.env.BACKEND_URL;
  if (!url || url.trim() === '') {
    throw new Error('BACKEND_URL environment variable is unset');
  }
  return url.replace(/\/+$/, '');
}
