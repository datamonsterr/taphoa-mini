import { MockHttpError } from './errors';
import { MOCK_ROUTES, type MockRoute } from './routes';

export type MockFetchOptions = {
  /** Simulated latency range in ms. Defaults to 120–350 ms, 0 when `NODE_ENV` is `test`. */
  latencyMs?: [number, number];
};

const DEFAULT_LATENCY: [number, number] = [120, 350];

type Compiled = { route: MockRoute; pattern: RegExp; names: string[] };

const compiled: Compiled[] = MOCK_ROUTES.map((route) => {
  const names: string[] = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      const match = /^\{(\w+)\}$/.exec(segment);
      if (!match) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(match[1]!);
      return '([^/]+)';
    })
    .join('/');
  return { route, pattern: new RegExp(`^${source}/?$`), names };
});

function json(status: number, body?: unknown): Response {
  if (status === 204 || body === undefined)
    return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, error: string, code: string) {
  return json(status, { error, code });
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A `fetch` that serves the OpenAPI surface from the in-memory mock DB.
 * It receives the `Request` that openapi-fetch builds, routes by method and path template and
 * answers with schema-shaped JSON (or an `Error` body for 4xx).
 */
export function createMockFetch(options: MockFetchOptions = {}): typeof fetch {
  const [min, max] =
    options.latencyMs ??
    (process.env.NODE_ENV === 'test' ? [0, 0] : DEFAULT_LATENCY);

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const delay = min + Math.random() * (max - min);
    if (delay > 0) await wait(delay);

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let pathMatched = false;
    for (const { route, pattern, names } of compiled) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = Object.fromEntries(
        names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]),
      );
      try {
        const result = await route.handler({
          request,
          params,
          query: url.searchParams,
        });
        return json(result.status, result.body);
      } catch (error) {
        if (error instanceof MockHttpError)
          return json(error.status, error.toBody());
        return errorResponse(
          500,
          error instanceof Error ? error.message : 'Mock failure',
          'internal_error',
        );
      }
    }
    return pathMatched
      ? errorResponse(
          405,
          `${method} is not allowed on ${url.pathname}`,
          'method_not_allowed',
        )
      : errorResponse(
          404,
          `No mock route for ${method} ${url.pathname}`,
          'not_found',
        );
  }) as typeof fetch;
}
