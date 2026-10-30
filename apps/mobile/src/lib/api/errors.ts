import type { ApiErrorBody } from './types';
import { networkErrorText, statusErrorText } from './errorText';

/** A non-2xx API response. `message` is a user-facing sentence by status; the server's English text stays in `body.error` for logs. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
    /** `Retry-After` header in milliseconds, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(statusErrorText(status, retryAfterMs));
    this.name = 'ApiError';
  }

  get code(): string | undefined {
    return this.body.code;
  }
}

export const isApiError = (value: unknown): value is ApiError =>
  value instanceof ApiError;

type Result<T> = { data?: T; error?: unknown; response: Response };

function toBody(error: unknown, response: Response): ApiErrorBody {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as ApiErrorBody).error === 'string'
  ) {
    return error as ApiErrorBody;
  }
  return { error: response.statusText || `HTTP ${response.status}` };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers?.get('retry-after');
  if (raw == null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Returns `data` of an openapi-fetch result or throws `ApiError` on a non-2xx response. */
export async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (error !== undefined || !response.ok) {
    throw new ApiError(
      response.status,
      toBody(error, response),
      retryAfterMs(response),
    );
  }
  return data as T;
}

/** User-facing sentence for any thrown error: an ApiError by status, anything else as no network. */
export const apiErrorText = (error: unknown): string =>
  isApiError(error) ? error.message : networkErrorText();

/** What the user reads when the backend answers 429 on a scan, point tap or receipt read. */
export const RATE_LIMIT_MESSAGE =
  'Bạn thao tác quá nhanh. Đợi một lát rồi thử lại.';

/** True for HTTP 429 `too_many_requests`: wait and try again, nothing is broken. */
export const isRateLimited = (error: unknown): boolean =>
  isApiError(error) && error.status === 429;

/**
 * React Query `retry` rule: a network error or 5xx may succeed later (3 tries); a 4xx other than
 * 408, 425 and 429 is the server's final answer, so retrying a 404 only keeps the spinner up.
 */
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= 3) return false;
  if (!isApiError(error)) return true;
  return (
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429
  );
}
