// Node 24 executes TypeScript directly; use the .ts extension for this entrypoint.
import { deleteUser, listUsers, type ClerkUser } from './clerk.ts';

const usage =
  'Usage: clerk:sweep [--prefix e2e-<name>] [--max-age-hours N] (N may be 0 only with --prefix)';
const args = process.argv.slice(2);
let prefix = 'e2e-';
let prefixGiven = false;
let hours = 24;
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (value === undefined) throw new Error(usage);
  if (args[i] === '--prefix' && !prefixGiven) {
    prefix = value;
    prefixGiven = true;
  } else if (args[i] === '--max-age-hours') {
    hours = Number(value);
  } else {
    throw new Error(usage);
  }
}
// Seed and real users never start with `e2e-`, so no prefix can reach them.
if (!prefix.startsWith('e2e-'))
  throw new Error('--prefix must start with e2e-');
if (!Number.isFinite(hours) || hours < 0 || (hours === 0 && !prefixGiven))
  throw new Error(
    '--max-age-hours must be positive (0 only together with --prefix)',
  );
const cutoff = Date.now() - hours * 60 * 60 * 1000;
const candidates: ClerkUser[] = [];
// Gather first: deleting while using offset pagination would skip users.
for (let offset = 0; ; offset += 100) {
  const users = await listUsers({
    email_address_query: '+clerk_test',
    limit: 100,
    offset,
  });
  candidates.push(
    ...users.filter(
      (user) =>
        (hours === 0 || user.created_at < cutoff) &&
        user.email_addresses.some(
          (email) =>
            email.email_address.startsWith(prefix) &&
            email.email_address.includes('+clerk_test'),
        ),
    ),
  );
  if (users.length < 100) break;
}
let failures = 0;
for (const user of candidates) {
  try {
    await deleteUser(user.id);
  } catch {
    failures++;
  }
}
console.log(
  `Clerk sweep: ${candidates.length - failures} deleted, ${failures} failed.`,
);
if (failures) process.exitCode = 1;
