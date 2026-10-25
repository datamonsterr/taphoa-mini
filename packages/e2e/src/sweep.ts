// Node 24 executes TypeScript directly; use the .ts extension for this entrypoint.
import { deleteUser, listUsers, type ClerkUser } from './clerk.ts';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--max-age-hours')) {
  throw new Error('Usage: clerk:sweep [--max-age-hours 24]');
}
const hours = Number(args[1] ?? 24);
if (!Number.isFinite(hours) || hours <= 0)
  throw new Error('--max-age-hours must be positive');
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
        user.created_at < cutoff &&
        user.email_addresses.some((email) =>
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
