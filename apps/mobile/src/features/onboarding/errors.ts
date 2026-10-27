import { isApiError } from '@/lib/api/errors';

/**
 * Dictionary key for a failed onboarding call; a non-API error means the server was unreachable.
 */
export function onboardingErrorKey(
  error: unknown,
  unauthorized = 'error.generic',
): string {
  if (!isApiError(error)) return 'error.network';
  switch (error.status) {
    case 400:
      return 'error.invalid';
    case 401:
      return unauthorized;
    case 410:
      return 'error.invite';
    case 429:
      return 'error.rateLimit';
    default:
      return error.status >= 500 ? 'error.server' : 'error.generic';
  }
}

/** The invite token as typed or pasted: spaces dropped, a `taphoa://join?token=` link reduced to its token. */
export function parseInviteToken(input: string): string {
  const trimmed = input.trim();
  const fromLink = /[?&]token=([^&#\s]+)/.exec(trimmed)?.[1];
  const token = fromLink ? decodeURIComponent(fromLink) : trimmed;
  return token.replace(/\s+/g, '').toUpperCase();
}
