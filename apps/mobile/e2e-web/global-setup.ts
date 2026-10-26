import { clerkSetup } from '@clerk/testing/playwright';
import { deleteUser } from '@taphoa/e2e/clerk';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The attributes the Clerk instance requires at sign-up besides the email address. The app's
 * sign-up is email + code only: while the dashboard requires anything else (a password, a name)
 * Clerk leaves the sign-up in `missing_requirements` and a brand-new email cannot get an
 * account. The spec of that path skips itself with this list as the reason. Unknown (the
 * environment cannot be read): none.
 */
async function signUpBlockers(frontendApi: string | undefined) {
  if (!frontendApi) return [];
  try {
    const response = await fetch(`https://${frontendApi}/v1/environment`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const environment = (await response.json()) as {
      user_settings?: {
        attributes?: Record<string, { enabled?: boolean; required?: boolean }>;
      };
    };
    return Object.entries(environment.user_settings?.attributes ?? {})
      .filter(
        ([name, a]) => a.enabled && a.required && name !== 'email_address',
      )
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/**
 * Fails the whole run up front, with the fix in the message, when something every spec needs is
 * missing: the Clerk development instance keys or the real backend (instead of every spec
 * timing out on a failed request).
 *
 * It also fetches the Clerk testing token (`clerkSetup`, which lets the specs sign in without
 * bot protection) and, on the way out, deletes every Clerk user the specs created.
 */
export default async function globalSetup() {
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ??
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const missing = [
    publishableKey?.trim() ? null : 'CLERK_PUBLISHABLE_KEY',
    process.env.CLERK_SECRET_KEY?.trim() ? null : 'CLERK_SECRET_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n` +
        'The web e2e suite signs in through Clerk. Export the keys of the Clerk DEVELOPMENT ' +
        'instance the backend verifies against (the same CLERK_PUBLISHABLE_KEY the backend ' +
        'runs with, plus CLERK_SECRET_KEY) in the shell that runs Playwright. Never put them ' +
        'in a file. See apps/mobile/CLERK.md, "Playwright web".',
    );
  }

  const api = (
    process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080'
  ).replace(/\/$/, '');
  const url = `${api}/readyz`;
  // /readyz also probes storage; a loaded host answers 503 now and then: look a few times.
  let problem: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    problem = undefined;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) break;
      problem = `HTTP ${response.status}`;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (problem !== undefined) {
    throw new Error(
      `Backend not ready at ${url} (${problem}).\n` +
        'The web e2e suite needs the real backend with recognition models. Start it with:\n' +
        '  scripts/e2e/stack.sh up\n' +
        'and stop it with `scripts/e2e/stack.sh down`. Set EXPO_PUBLIC_API_URL when the backend ' +
        'is not on http://localhost:8080.',
    );
  }

  // Sets CLERK_FAPI and CLERK_TESTING_TOKEN in process.env, which every worker inherits.
  // `dotenv: false`: the keys come from the shell only, never from a file in the repository.
  await clerkSetup({ publishableKey, dotenv: false });

  const blockers = await signUpBlockers(process.env.CLERK_FAPI);
  process.env.E2E_CLERK_SIGNUP_BLOCKED_BY = blockers.join(',');
  if (blockers.length > 0) {
    console.warn(
      `Clerk instance requires ${blockers.join(', ')} at sign-up: the email-code sign-up of new ` +
        'addresses cannot complete, so its spec is skipped (make these optional in the Clerk ' +
        'dashboard, or let the app supply them).',
    );
  }

  // Every Clerk user created through the Backend API appends its id to a file of its own
  // process here (packages/e2e/src/clerk.ts), so teardown deletes them even after failed tests.
  const tracking = mkdtempSync(path.join(tmpdir(), 'taphoa-clerk-web-e2e-'));
  process.env.CLERK_TRACKING_DIR = tracking;

  return async () => {
    const ids = new Set<string>();
    for (const file of readdirSync(tracking)) {
      for (const line of readFileSync(path.join(tracking, file), 'utf8')
        .trim()
        .split('\n')) {
        if (line) ids.add(JSON.parse(line) as string);
      }
    }
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await deleteUser(id);
      } catch {
        failed.push(id);
      }
    }
    delete process.env.CLERK_TRACKING_DIR;
    if (failed.length > 0) {
      // A cleanup problem must not fail a green run; the sweep removes stragglers after 24 h.
      console.warn(
        `Clerk cleanup failed for ${failed.length} of ${ids.size} users; ids kept in ${tracking}. ` +
          'Run `pnpm --filter @taphoa/e2e clerk:sweep` to remove stale +clerk_test users.',
      );
      return;
    }
    rmSync(tracking, { recursive: true });
  };
}
