import { afterAll } from 'vitest';
import { deleteCreatedUsers } from './clerk.js';

// Live suites run one file after another: delete the file's Clerk users when it ends instead of
// at the global teardown, so the run never holds more users than one file creates.
afterAll(async () => {
  await deleteCreatedUsers();
});
