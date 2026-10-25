import type { BankAccount, Member } from '@/lib/api/types';
import { newUuid } from '@/lib/uuid';
import { getMockDb, getCurrentMember, getStore } from './db';
import { badRequest, MockHttpError } from './errors';
import { asObject, parseStorePatch } from './validate';

const pins = new Map<string, string>();
export const resetMockAuth = () => pins.clear();
export function requireIdentity(request: Request) {
  if (!/^Bearer \S+$/.test(request.headers.get('authorization') ?? ''))
    throw new MockHttpError(401, 'unauthorized', 'Clerk session required');
}
const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw badRequest('Invalid name');
  return value.trim();
};
export function mockMe(request: Request) {
  requireIdentity(request);
  return {
    clerk_user_id: 'user_test',
    profile: { display_name: 'Cô Ba', email: 'coba@example.com' },
    memberships: getMockDb().hasMembership
      ? [{ store: getStore(), member: getCurrentMember() }]
      : [],
  };
}
function member(displayName: string, role: Member['role']): Member {
  return {
    id: newUuid(),
    display_name: displayName,
    role,
    can_enroll: role === 'lead',
    has_pin: false,
    active: true,
    created_at: new Date().toISOString(),
  };
}
export function mockCreateStore(request: Request, input: unknown) {
  requireIdentity(request);
  const body = asObject(input);
  const state = getMockDb();
  const bank =
    body.bank_account === undefined
      ? undefined
      : (parseStorePatch({ bank_account: body.bank_account })
          .bank_account as BankAccount);
  const store = {
    ...getStore(),
    id: newUuid(),
    name: text(body.store_name, 80),
    bank_account: bank ?? null,
  };
  const lead = member(text(body.display_name, 40), 'lead');
  state.store = store;
  state.members = [lead];
  state.currentMemberId = lead.id;
  state.hasMembership = true;
  return { store, member: lead };
}
export function mockJoinStore(request: Request, input: unknown) {
  requireIdentity(request);
  const body = asObject(input);
  text(body.invite_token, 256);
  const state = getMockDb();
  if (state.hasMembership)
    throw new MockHttpError(409, 'already_member', 'Already a member');
  const joined = member(text(body.display_name, 40), 'seller');
  state.members.push(joined);
  state.currentMemberId = joined.id;
  state.hasMembership = true;
  return { store: getStore(), member: joined };
}
export function mockSetPin(request: Request, input: unknown) {
  requireIdentity(request);
  const { pin } = asObject(input);
  if (pin !== null && (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)))
    throw badRequest('PIN must have 4–6 digits');
  const current = getCurrentMember();
  if (pin === null) pins.delete(current.id);
  else pins.set(current.id, pin as string);
  current.has_pin = pin !== null;
}
export function mockVerifyPin(request: Request, input: unknown) {
  requireIdentity(request);
  const { pin } = asObject(input);
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin))
    throw badRequest('PIN must have 4–6 digits');
  const current = getCurrentMember();
  if (current.has_pin && pin !== (pins.get(current.id) ?? '1234'))
    throw new MockHttpError(401, 'invalid_pin', 'Wrong PIN');
}
