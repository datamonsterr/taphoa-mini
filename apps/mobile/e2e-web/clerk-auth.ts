import type { Page } from '@playwright/test';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import {
  createSession,
  createSessionToken,
  createUser,
  deleteCreatedUsers,
  deleteUser,
  listUsers,
} from '@taphoa/e2e/clerk';

/**
 * Clerk identities for the web specs. Every address has the `+clerk_test` subaddress: Clerk
 * sends no mail for it and accepts `TEST_CODE` as its verification code (development
 * instances only). Seeding talks to the Backend API from Node; the browser signs in through
 * `@clerk/testing` (no typing) or, where a spec covers the sign-in screens, through the UI.
 */

/** The verification code every `+clerk_test` address accepts. */
export const TEST_CODE = '424242';

export const uniqueEmail = () =>
  `e2e-web-${crypto.randomUUID()}+clerk_test@example.com`;

/** A Clerk user with a Backend API session and a bearer token for node-side API calls. */
export type TestUser = {
  userId: string;
  email: string;
  sessionId: string;
  /** Session token, valid one hour: the specs finish well within it. */
  token: string;
};

/**
 * Creates the user, a session and one session token. Created ids are recorded for the global
 * teardown (see global-setup.ts), so a failing spec cannot leak users.
 */
export async function createClerkUser(
  email = uniqueEmail(),
): Promise<TestUser> {
  const user = await createUser({ email });
  const session = await createSession(user.id);
  const token = await createSessionToken(session.id, 3600);
  return { userId: user.id, email, sessionId: session.id, token };
}

/**
 * Deletes every Clerk user this worker created (stores, sellers, newcomers), called after each
 * test (see the `clerkCleanup` fixture): a Playwright worker runs one test at a time, so the
 * run holds about workers x users-per-test users at once, far below the development instance
 * cap of 100 users. Best effort: failures stay tracked for the global teardown and the sweep.
 */
export const deleteTestUsers = () => deleteCreatedUsers();

/**
 * Deletes the users with exactly this address: the ones a spec created through the sign-in
 * screens, which no fixture tracked. Failures are swallowed on purpose; `clerk:sweep` removes
 * stragglers.
 */
export async function deleteClerkUsersByEmail(email: string): Promise<void> {
  try {
    const users = await listUsers({ email_address_query: email, limit: 10 });
    for (const user of users) {
      if (user.email_addresses.some((a) => a.email_address === email))
        await deleteUser(user.id);
    }
  } catch {
    // best effort
  }
}

const SIGN_IN_ATTEMPTS = 5;

/**
 * Signs the page's browser context in as `email` without typing: opens the (unprotected)
 * sign-in route so Clerk loads, then `clerk.signIn({ emailAddress })` mints a sign-in ticket
 * through the Backend API and redeems it in the page. The testing token (set up by global-setup)
 * is added to every Frontend API request of the context.
 *
 * Frontend API limits (5 sign-ins and 3 first-factor attempts per 10 s per IP) and Backend API
 * 429s surface as errors here: back off with jitter and try again on a fresh page load.
 */
export async function signInPage(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto('/sign-in');
      await clerk.signIn({ page, emailAddress: email });
      return;
    } catch (error) {
      if (attempt >= SIGN_IN_ATTEMPTS) throw error;
      await page.waitForTimeout(
        Math.min(2_000 * 2 ** (attempt - 1), 16_000) + Math.random() * 1_000,
      );
    }
  }
}
