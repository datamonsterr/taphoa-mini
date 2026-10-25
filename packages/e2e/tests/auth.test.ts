import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  assertErrorResponse,
  assertMe,
  assertStoreMembership,
  createClerkUser,
  createStore,
  joinAsSeller,
  newClient,
  uniqueName,
} from '../src/helpers.js';
import { getBackendUrl } from '../src/env.js';

const storeBody = () => ({
  store_name: uniqueName('Store'),
  display_name: uniqueName('Lead'),
});

describe('Clerk identity and store membership', () => {
  it('requires a bearer for store creation and rejects garbage bearers', async () => {
    for (const token of [undefined, 'garbage']) {
      const result = await newClient(token).raw.POST('/v1/stores', {
        body: storeBody(),
      });
      expect(result.response.status).toBe(401);
      assertErrorResponse(result.error, 'unauthorized');
    }
  });

  it('creates a lead membership with a Clerk token', async () => {
    const user = await createClerkUser();
    const result = await newClient(user.token).raw.POST('/v1/stores', {
      body: storeBody(),
    });
    expect(result.response.status).toBe(201);
    assertStoreMembership(result.data);
    expect(result.data.member.role).toBe('lead');
    expect(result.data.member.can_enroll).toBe(true);
  });

  it('returns a profile or null and empty memberships before onboarding', async () => {
    const user = await createClerkUser();
    const client = newClient(user.token);
    const me = await client.raw.GET('/v1/me');
    expect(me.response.status).toBe(200);
    assertMe(me.data);
    expect(me.data.clerk_user_id).toBe(user.userId);
    expect(me.data.memberships).toEqual([]);
    const store = await client.raw.GET('/v1/store');
    expect(store.response.status).toBe(403);
    assertErrorResponse(store.error, 'membership_required');
  });

  it('lists two stores and requires selection of an active membership', async () => {
    const first = await createStore();
    const identityClient = newClient(first.user.token);
    const second = await identityClient.raw.POST('/v1/stores', {
      body: storeBody(),
    });
    expect(second.response.status).toBe(201);
    assertStoreMembership(second.data);
    const me = await identityClient.raw.GET('/v1/me');
    expect(me.response.status).toBe(200);
    assertMe(me.data);
    expect(me.data.memberships.map((m) => m.store.id)).toEqual([
      first.session.store.id,
      second.data.store.id,
    ]);
    const missing = await identityClient.raw.GET('/v1/store');
    expect(missing.response.status).toBe(400);
    assertErrorResponse(missing.error, 'store_required');
    for (const storeId of [first.session.store.id, second.data.store.id]) {
      const selected = await newClient(first.user.token, storeId).raw.GET(
        '/v1/store',
      );
      expect(selected.response.status).toBe(200);
      expect(selected.data?.id).toBe(storeId);
    }
    const foreign = await createStore();
    const forbidden = await newClient(
      first.user.token,
      foreign.session.store.id,
    ).raw.GET('/v1/store');
    expect(forbidden.response.status).toBe(403);
    assertErrorResponse(forbidden.error, 'forbidden');
    const malformed = await newClient(first.user.token, 'not-a-uuid').raw.GET(
      '/v1/store',
    );
    expect(malformed.response.status).toBe(400);
    assertErrorResponse(malformed.error, 'validation_failed');
  });

  it('selects the only membership when no store header is supplied', async () => {
    const store = await createStore();
    const result = await newClient(store.user.token).raw.GET('/v1/store');
    expect(result.response.status).toBe(200);
    expect(result.data?.id).toBe(store.session.store.id);
  });

  it('rejects a second join by the same Clerk user with a fresh invite', async () => {
    const lead = await createStore();
    const seller = await joinAsSeller(lead.client);
    const invite = await lead.client.raw.POST('/v1/invites', {
      body: { role: 'seller' },
    });
    expect(invite.response.status).toBe(201);
    const result = await seller.client.raw.POST('/v1/auth/join', {
      body: { invite_token: invite.data!.token, display_name: 'Again' },
    });
    expect(result.response.status).toBe(409);
    assertErrorResponse(result.error, 'already_member');
  });

  it('rejects a used invite for a different user', async () => {
    const lead = await createStore();
    const seller = await joinAsSeller(lead.client);
    const other = await createClerkUser();
    const result = await newClient(other.token).raw.POST('/v1/auth/join', {
      body: { invite_token: seller.invite.token, display_name: 'Other' },
    });
    expect(result.response.status).toBe(410);
    assertErrorResponse(result.error, 'invite_unavailable');
  });

  it('rejects an expired invite', async () => {
    const lead = await createStore();
    const user = await createClerkUser();
    const invite = await lead.client.raw.POST('/v1/invites', {
      body: { role: 'seller', ttl_seconds: 60 },
    });
    expect(invite.response.status).toBe(201);
    await delay(
      Math.max(0, Date.parse(invite.data!.expires_at) - Date.now()) + 1000,
    );
    const result = await newClient(user.token).raw.POST('/v1/auth/join', {
      body: { invite_token: invite.data!.token, display_name: 'Late' },
    });
    expect(result.response.status).toBe(410);
    assertErrorResponse(result.error, 'invite_unavailable');
  }, 90000);

  it('verifies PINs, rejects incorrect PINs, and locks repeated failures', async () => {
    const { client } = await createStore();
    const set = await client.raw.PUT('/v1/me/pin', { body: { pin: '1234' } });
    expect(set.response.status).toBe(204);
    const right = await client.raw.POST('/v1/me/pin/verify', {
      body: { pin: '1234' },
    });
    expect(right.response.status).toBe(204);
    const wrong = await client.raw.POST('/v1/me/pin/verify', {
      body: { pin: '9999' },
    });
    expect(wrong.response.status).toBe(401);
    assertErrorResponse(wrong.error, 'invalid_pin');
    let locked = false;
    for (let i = 0; i < 20; i++) {
      const result = await client.raw.POST('/v1/me/pin/verify', {
        body: { pin: '9999' },
      });
      if (result.response.status === 429) {
        locked = true;
        break;
      }
      expect(result.response.status).toBe(401);
      assertErrorResponse(result.error, 'invalid_pin');
    }
    expect(locked).toBe(true);
  });

  it('allows PIN verification for a member without a PIN', async () => {
    const { client } = await createStore();
    const result = await client.raw.POST('/v1/me/pin/verify', {
      body: { pin: '1234' },
    });
    expect(result.response.status).toBe(204);
  });

  it.each(['refresh', 'recover', 'switch', 'logout'])(
    'removes the legacy %s route',
    async (route) => {
      // Removed paths intentionally do not exist in the generated client.
      const result = await fetch(`${getBackendUrl()}/v1/auth/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(result.ok).toBe(false);
      expect(result.status).not.toBe(401);
      expect([404, 405]).toContain(result.status);
    },
  );
});
