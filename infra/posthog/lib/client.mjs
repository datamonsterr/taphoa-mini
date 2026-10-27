export function createClient({
  apiKey,
  projectId,
  host = 'https://us.posthog.com',
  fetch: fetchImpl = globalThis.fetch,
}) {
  const base = new URL(`/api/projects/${encodeURIComponent(projectId)}/`, host);
  const redact = (message) =>
    String(message)
      .replaceAll(apiKey, '[REDACTED]')
      .replace(
        /authorization["']?\s*[:=]\s*[^\n]+/gi,
        'Authorization: [REDACTED]',
      );
  async function request(method, path, body) {
    const url = new URL(path, base);
    if (url.origin !== base.origin)
      throw new Error('API URL must have the configured origin');
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw new Error(
          `PostHog ${method} failed (${response.status}): ${await response.text()}`,
        );
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      throw new Error(redact(error.message));
    }
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    async listAll(path) {
      const items = [];
      const visited = new Set();
      while (path) {
        const key = String(new URL(path, base));
        if (visited.has(key)) throw new Error('Repeated pagination URL');
        visited.add(key);
        const page = await request('GET', path);
        if (Array.isArray(page)) {
          items.push(...page);
          break;
        }
        if (!Array.isArray(page.results))
          throw new Error('Invalid PostHog list response');
        items.push(...page.results);
        path = page.next;
      }
      return items;
    },
  };
}
