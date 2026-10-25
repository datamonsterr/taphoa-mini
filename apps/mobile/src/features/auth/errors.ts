/** Core 3 wraps API failures in ClerkError.cause; legacy SSO can throw errors[]. */
export function clerkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    code?: string;
    errors?: { code?: string }[];
    cause?: unknown;
  };
  return (
    value.errors?.[0]?.code ??
    (value.cause && value.cause !== error
      ? clerkErrorCode(value.cause)
      : undefined) ??
    value.code
  );
}
export function authErrorKey(error: unknown): string {
  switch (clerkErrorCode(error)) {
    case 'form_code_incorrect':
    case 'verification_failed':
      return 'wrongCode';
    case 'verification_expired':
    case 'form_code_expired':
      return 'expiredCode';
    case 'too_many_requests':
    case 'too_many_attempts':
    case 'rate_limit_exceeded':
      return 'rateLimited';
    case 'network_error':
    case 'network_request_failed':
    case 'api_request_failed':
      return 'network';
    default:
      return error instanceof TypeError ? 'network' : 'generic';
  }
}
