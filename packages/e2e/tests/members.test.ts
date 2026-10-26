import { describe, expect, it } from 'vitest';
import {
  assertErrorResponse,
  assertInvite,
  assertMember,
  assertMe,
  assertStoreMembership,
  createStore,
  joinAsSeller,
  uniqueName,
} from '../src/helpers.js';

describe('Members & Invites Contract Specs (Clerk)', () => {
  describe('GET /v1/members', () => {
    it('lists members with active members first', async () => {
      const { client: leadClient, session: leadSession } = await createStore();
      const { session: sellerSession } = await joinAsSeller(leadClient);

      const { data, error, response } = await leadClient.raw.GET('/v1/members');

      expect(response.status).toBe(200);
      expect(error).toBeUndefined();
      expect(data).toBeDefined();
      expect(Array.isArray(data!.items)).toBe(true);
      expect(data!.items.length).toBeGreaterThanOrEqual(2);

      for (const member of data!.items) {
        assertMember(member);
      }

      // Check lead and seller are present
      const memberIds = data!.items.map((m) => m.id);
      expect(memberIds).toContain(leadSession.member.id);
      expect(memberIds).toContain(sellerSession.member.id);

      // Verify active members come first
      let seenInactive = false;
      for (const m of data!.items) {
        if (!m.active) {
          seenInactive = true;
        } else if (seenInactive) {
          // If active is true after seeing inactive, ordering constraint is violated
          expect(m.active).toBe(false);
        }
      }
    });
  });

  describe('POST /v1/invites', () => {
    it('creates invite as lead with 201 returning token, join_url (taphoa://join?token=...), and expires_at', async () => {
      const { client: leadClient } = await createStore();

      const { data, error, response } = await leadClient.raw.POST(
        '/v1/invites',
        {
          body: {
            role: 'seller',
            can_enroll: true,
            ttl_seconds: 300,
          },
        },
      );

      expect(response.status).toBe(201);
      expect(error).toBeUndefined();
      expect(data).toBeDefined();

      assertInvite(data!);
      expect(data!.role).toBe('seller');
      expect(data!.can_enroll).toBe(true);
      expect(data!.join_url).toMatch(/^taphoa:\/\/join\?token=[0-9A-Za-z]+$/);
      expect(new Date(data!.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('returns 403 Forbidden when called by a seller', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);

      const { data, error, response } = await sellerClient.raw.POST(
        '/v1/invites',
        {
          body: {
            role: 'seller',
          },
        },
      );

      expect(response.status).toBe(403);
      expect(data).toBeUndefined();
      assertErrorResponse(error);
    });
  });

  describe('PATCH /v1/members/{memberId}', () => {
    it('allows Lead to update display_name, role, and can_enroll on members', async () => {
      const { client: leadClient } = await createStore();
      const { session: sellerSession } = await joinAsSeller(leadClient, {
        can_enroll: false,
      });

      const updatedName = 'Em Gai ' + uniqueName('seller');
      const patchRes = await leadClient.raw.PATCH('/v1/members/{memberId}', {
        params: { path: { memberId: sellerSession.member.id } },
        headers: { 'content-type': 'application/merge-patch+json' },
        body: {
          display_name: updatedName,
          can_enroll: true,
          role: 'lead',
        },
      });

      expect(patchRes.response.status).toBe(200);
      expect(patchRes.data).toBeDefined();
      assertMember(patchRes.data!);
      expect(patchRes.data!.display_name).toBe(updatedName);
      expect(patchRes.data!.can_enroll).toBe(true);
      expect(patchRes.data!.role).toBe('lead');
    });

    it('returns 403 Forbidden when a seller attempts to patch member details', async () => {
      const { client: leadClient, session: leadSession } = await createStore();
      const { client: sellerClient } = await joinAsSeller(leadClient);

      const patchRes = await sellerClient.raw.PATCH('/v1/members/{memberId}', {
        params: { path: { memberId: leadSession.member.id } },
        headers: { 'content-type': 'application/merge-patch+json' },
        body: {
          display_name: 'Usurped Lead',
        },
      });

      expect(patchRes.response.status).toBe(403);
      assertErrorResponse(patchRes.error);
    });

    it('returns 409 code last_lead when attempting to demote the sole active lead', async () => {
      const { client: leadClient, session: leadSession } = await createStore();

      // Lead attempts to demote themself to seller when they are the only lead
      const patchRes = await leadClient.raw.PATCH('/v1/members/{memberId}', {
        params: { path: { memberId: leadSession.member.id } },
        headers: { 'content-type': 'application/merge-patch+json' },
        body: {
          role: 'seller',
        },
      });

      expect(patchRes.response.status).toBe(409);
      assertErrorResponse(patchRes.error, 'last_lead');
    });
  });

  describe('DELETE /v1/members/{memberId}', () => {
    it('deactivates membership immediately and reactivates it through a new invite', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: sellerSession } =
        await joinAsSeller(leadClient);

      // Lead deactivates the seller
      const deleteRes = await leadClient.raw.DELETE('/v1/members/{memberId}', {
        params: { path: { memberId: sellerSession.member.id } },
      });
      expect(deleteRes.response.status).toBe(204);

      const denied = await sellerClient.raw.GET('/v1/store');
      expect(denied.response.status).toBe(403);
      assertErrorResponse(denied.error);
      const me = await sellerClient.raw.GET('/v1/me');
      expect(me.response.status).toBe(200);
      assertMe(me.data);
      expect(
        me.data.memberships.some((m) => m.store.id === sellerSession.store.id),
      ).toBe(false);

      // Members list shows the deactivated member with active === false
      const listRes = await leadClient.raw.GET('/v1/members');
      expect(listRes.response.status).toBe(200);
      const deactivated = listRes.data!.items.find(
        (m) => m.id === sellerSession.member.id,
      );
      expect(deactivated).toBeDefined();
      expect(deactivated!.active).toBe(false);

      const invite = await leadClient.raw.POST('/v1/invites', {
        body: { role: 'seller', can_enroll: true },
      });
      expect(invite.response.status).toBe(201);
      const rejoined = await sellerClient.raw.POST('/v1/auth/join', {
        body: { invite_token: invite.data!.token, display_name: 'Reactivated' },
      });
      expect(rejoined.response.status).toBe(201);
      assertStoreMembership(rejoined.data);
      expect(rejoined.data.member.id).toBe(sellerSession.member.id);
      expect(rejoined.data.member.active).toBe(true);
      expect(rejoined.data.member.role).toBe('seller');
      expect(rejoined.data.member.can_enroll).toBe(true);
      const restored = await sellerClient.raw.GET('/v1/store');
      expect(restored.response.status).toBe(200);
      expect(restored.data?.id).toBe(sellerSession.store.id);
      const restoredMe = await sellerClient.raw.GET('/v1/me');
      expect(restoredMe.response.status).toBe(200);
      assertMe(restoredMe.data);
      expect(restoredMe.data.memberships.map((m) => m.store.id)).toContain(
        sellerSession.store.id,
      );
    });

    it('returns 409 Conflict when attempting to delete the last active lead', async () => {
      const { client: leadClient, session: leadSession } = await createStore();

      const deleteRes = await leadClient.raw.DELETE('/v1/members/{memberId}', {
        params: { path: { memberId: leadSession.member.id } },
      });

      expect(deleteRes.response.status).toBe(409);
      assertErrorResponse(deleteRes.error);
    });

    it('returns 404 when deleting an unknown member ID', async () => {
      const { client: leadClient } = await createStore();

      const deleteRes = await leadClient.raw.DELETE('/v1/members/{memberId}', {
        params: {
          path: { memberId: '00000000-0000-0000-0000-000000000000' },
        },
      });

      expect(deleteRes.response.status).toBe(404);
      assertErrorResponse(deleteRes.error);
    });
  });
});
