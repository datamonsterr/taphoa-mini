import type { Me } from '@/lib/api/store';

import { personName, type DeviceSession } from './deviceSessions';

const session = {
  id: 'sess_1',
  user: { primaryEmailAddress: { emailAddress: 'b+clerk_test@example.com' } },
} as unknown as DeviceSession;

const me = (displayName: string | null, memberNames: string[]): Me =>
  ({
    profile: { display_name: displayName, email: 'b+clerk_test@example.com' },
    memberships: memberNames.map((name) => ({
      member: { display_name: name },
    })),
  }) as unknown as Me;

describe('personName', () => {
  it('prefers the Clerk profile name', () => {
    expect(personName(session, me('Lan', ['Chu B']))).toBe('Lan');
  });

  it('falls back to the name the person gave their store', () => {
    expect(personName(session, me(null, ['Chu B']))).toBe('Chu B');
    expect(personName(session, me('  ', ['  ', 'Chu B']))).toBe('Chu B');
  });

  it('falls back to the email without a name', () => {
    expect(personName(session, me(null, []))).toBe('b+clerk_test@example.com');
    expect(personName(session)).toBe('b+clerk_test@example.com');
  });
});
