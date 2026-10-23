import type { ApiErrorBody } from './types';

/** A non-2xx API response: HTTP status plus the `Error` schema body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.error);
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

/** Returns `data` of an openapi-fetch result or throws `ApiError` on a non-2xx response. */
export async function unwrap<T>(request: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (error !== undefined || !response.ok) {
    throw new ApiError(response.status, toBody(error, response));
  }
  return data as T;
}
