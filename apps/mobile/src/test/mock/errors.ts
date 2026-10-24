import type { ApiErrorBody } from '@/lib/api/types';

/** Thrown by the mock DB and routes; the mock fetch turns it into an `Error` response body. */
export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MockHttpError';
  }

  toBody(): ApiErrorBody {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const badRequest = (
  message: string,
  details?: Record<string, unknown>,
  code = 'validation_failed',
) => new MockHttpError(400, code, message, details);

export const notFound = (what: string) =>
  new MockHttpError(404, 'not_found', `${what} not found`);

export const unprocessableEntity = (
  message: string,
  details?: Record<string, unknown>,
  code = 'validation_failed',
) => new MockHttpError(422, code, message, details);

export const conflict = (code: string, message: string) =>
  new MockHttpError(409, code, message);
