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

const MAX_DEPTH = 5;

/** Every code on the error, its `errors[]` entries and its `cause` chain, most specific first. */
function clerkErrorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > MAX_DEPTH) return [];
  const value = error as {
    code?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  const codes: string[] = [];
  if (Array.isArray(value.errors))
    for (const entry of value.errors)
      codes.push(...clerkErrorCodes(entry, depth + 1));
  if (value.cause && value.cause !== error)
    codes.push(...clerkErrorCodes(value.cause, depth + 1));
  if (typeof value.code === 'string') codes.push(value.code);
  return codes;
}

/** The HTTP status Clerk attached to the failure, wherever the wrapper put it. */
function clerkErrorStatus(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > MAX_DEPTH)
    return undefined;
  const value = error as { status?: unknown; cause?: unknown };
  if (typeof value.status === 'number') return value.status;
  return value.cause && value.cause !== error
    ? clerkErrorStatus(value.cause, depth + 1)
    : undefined;
}

const NETWORK_MESSAGE =
  /network|failed to fetch|load failed|internet|offline|disconnected|timed? ?out/i;

/** A fetch that never reached Clerk: a `TypeError` from fetch, or an error that says so. */
function isNetworkFailure(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > MAX_DEPTH) return false;
  const value = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (error instanceof TypeError || value.name === 'TypeError') return true;
  // An API answer (it has an `errors[]` entry with a code) is never a network failure.
  if (
    Array.isArray(value.errors) &&
    value.errors.some((entry) => clerkErrorCodes(entry).length > 0)
  )
    return false;
  if (typeof value.message === 'string' && NETWORK_MESSAGE.test(value.message))
    return true;
  return value.cause && value.cause !== error
    ? isNetworkFailure(value.cause, depth + 1)
    : false;
}

const KEY_BY_CODE: Record<string, string> = {
  form_code_incorrect: 'wrongCode',
  verification_failed: 'wrongCode',
  verification_expired: 'expiredCode',
  form_code_expired: 'expiredCode',
  too_many_requests: 'rateLimited',
  too_many_attempts: 'rateLimited',
  rate_limit_exceeded: 'rateLimited',
  network_error: 'network',
  network_request_failed: 'network',
  api_request_failed: 'network',
  form_identifier_not_found: 'unknownEmail',
  identifier_already_signed_in: 'alreadySignedIn',
  session_exists: 'alreadySignedIn',
  form_param_format_invalid: 'invalidEmail',
  form_identifier_invalid: 'invalidEmail',
  user_locked: 'locked',
  sign_up_mode_restricted: 'notAllowed',
  not_allowed_access: 'notAllowed',
  not_allowed_to_sign_up: 'notAllowed',
};

/**
 * Dictionary key (see `strings.ts`) for a failed Clerk call, so each failure shows its own
 * message: wrong or expired code, too many tries, no network, unknown email, and so on.
 */
export function authErrorKey(error: unknown): string {
  for (const code of clerkErrorCodes(error)) {
    const key = KEY_BY_CODE[code];
    if (key) return key;
  }
  if (clerkErrorStatus(error) === 429) return 'rateLimited';
  return isNetworkFailure(error) ? 'network' : 'generic';
}

/** Error-like values a Clerk resource keeps for its last call (`resource.errors`). */
function resourceFailures(resource: unknown): unknown[] {
  const errors = (resource as { errors?: unknown } | null)?.errors as
    | {
        raw?: unknown[] | null;
        global?: unknown[] | null;
        fields?: Record<string, unknown> | null;
      }
    | undefined;
  if (!errors) return [];
  return [
    ...(errors.raw ?? []),
    ...(errors.global ?? []),
    ...Object.values(errors.fields ?? {}).filter(Boolean),
  ];
}

/**
 * What went wrong when a Clerk call resolved without a usable result. Core 3 reports most
 * failures in `result.error`, but some (an offline phone, a rate limit) only show up on the
 * resource's own `errors`. `undefined` means nothing failed.
 */
export function authFailureKey(
  result: { error?: unknown } | null | undefined,
  resource: unknown,
  online: boolean,
): string | undefined {
  if (result?.error) return authErrorKey(result.error);
  for (const failure of resourceFailures(resource)) {
    const key = authErrorKey(failure);
    if (key !== 'generic') return key;
  }
  if (!online) return 'network';
  return resourceFailures(resource).length > 0 ? 'generic' : undefined;
}

type Verification = { expireAt?: Date | number | null } | undefined;
type Verifiable = {
  firstFactorVerification?: Verification;
  verifications?: { emailAddress?: Verification };
};

const verificationOf = (
  resource: unknown,
  mode: 'signIn' | 'signUp',
): Verification =>
  mode === 'signIn'
    ? (resource as Verifiable | null)?.firstFactorVerification
    : (resource as Verifiable | null)?.verifications?.emailAddress;

/** When the code Clerk last sent expires; null before any code. Read it before asking for a code. */
export const codeExpiry = (
  resource: unknown,
  mode: 'signIn' | 'signUp',
): number | null => verificationOf(resource, mode)?.expireAt?.valueOf() ?? null;

/**
 * Whether Clerk really sent a code. An offline phone makes Clerk resolve `sendCode` quietly
 * without sending anything (and without an error), so the only sign is the resource itself: a
 * sent code carries a new expiry. A resource that keeps no verification state cannot say, and
 * counts as sent.
 */
export function codeWasSent(
  resource: unknown,
  mode: 'signIn' | 'signUp',
  expiryBefore: number | null,
): boolean {
  const after = verificationOf(resource, mode);
  if (after === undefined) return true;
  const expiry = after?.expireAt?.valueOf() ?? null;
  return expiry !== null && expiry !== expiryBefore;
}
