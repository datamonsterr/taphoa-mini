import { describe, expect, it } from 'vitest';
import {
  assertAuthSession,
  assertErrorResponse,
  assertMember,
  assertStore,
  authedClient,
  createStore,
  joinAsSeller,
  newClient,
  RECOVERY_CODE_REGEX,
  uniqueName,
} from '../src/helpers.js';

describe('Auth & Session Contract Specs (E1)', () => {
  describe('POST /v1/stores', () => {
    it('creates store and first lead with 201, returning tokens, lead member, store info, and recovery code', async () => {
      const client = newClient();
      const storeName = uniqueName('TapHoa');
      const displayName = 'Me ' + uniqueName('lead');

      const { data, error, response } = await client.raw.POST('/v1/stores', {
        body: {
          store_name: storeName,
          display_name: displayName,
          device: {
            name: 'Lead Phone',
            platform: 'android',
            app_version: '1.0.0',
          },
        },
      });

      expect(response.status).toBe(201);
      expect(error).toBeUndefined();
      expect(data).toBeDefined();

      assertAuthSession(data);
      expect(data.recovery_code).toMatch(RECOVERY_CODE_REGEX);

      // Verify member shape and lead defaults
      expect(data.member.role).toBe('lead');
      expect(data.member.can_enroll).toBe(true);
      expect(data.member.has_pin).toBe(false);
      expect(data.member.active).toBe(true);
      expect(data.member.display_name).toBe(displayName);

      // Verify store shape and defaults
      expect(data.store.name).toBe(storeName);
      expect(data.store.timezone).toBe('Asia/Ho_Chi_Minh');
      expect(data.store.version).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 validation_failed for empty store_name', async () => {
      const client = newClient();
      const { data, error, response } = await client.raw.POST('/v1/stores', {
        body: {
          store_name: '',
          display_name: 'Lead',
          device: {
            name: 'Device',
            platform: 'android',
          },
        },
      });

      expect(response.status).toBe(400);
      expect(data).toBeUndefined();
      assertErrorResponse(error, 'validation_failed');
    });
  });

  describe('GET /v1/me', () => {
    it('returns 200 with current member and store when valid token provided', async () => {
      const { client, session } = await createStore();

      const { data, error, response } = await client.raw.GET('/v1/me');

      expect(response.status).toBe(200);
      expect(error).toBeUndefined();
      expect(data).toBeDefined();

      assertMember(data!.member);
      assertStore(data!.store);
      expect(data!.member.id).toBe(session.member.id);
      expect(data!.store.id).toBe(session.store.id);
    });

    it('returns 401 code unauthorized when called without token', async () => {
      const client = newClient();
      const { data, error, response } = await client.raw.GET('/v1/me');

      expect(response.status).toBe(401);
      expect(data).toBeUndefined();
      assertErrorResponse(error, 'unauthorized');
    });

    it('returns 401 code unauthorized when called with garbage token', async () => {
      const client = newClient('garbage-invalid-token-xyz-123456');
      const { data, error, response } = await client.raw.GET('/v1/me');

      expect(response.status).toBe(401);
      expect(data).toBeUndefined();
      assertErrorResponse(error, 'unauthorized');
    });
  });

  describe('Invite -> Join (/v1/invites, /v1/auth/join)', () => {
    it('allows joining via invite token with 201, role seller, and non-null session', async () => {
      const { client: leadClient } = await createStore();
      const sellerDisplayName = 'Ba noi ' + uniqueName('seller');

      const { session: sellerSession } = await joinAsSeller(leadClient, {
        can_enroll: false,
        display_name: sellerDisplayName,
      });

      assertAuthSession(sellerSession);
      expect(sellerSession.member.role).toBe('seller');
      expect(sellerSession.member.can_enroll).toBe(false);
      expect(sellerSession.member.has_pin).toBe(false);
      expect(sellerSession.member.active).toBe(true);
      expect(sellerSession.member.display_name).toBe(sellerDisplayName);
    });

    it('rejects reuse of the same invite token with 410', async () => {
      const { client: leadClient } = await createStore();

      const { invite } = await joinAsSeller(leadClient);

      // Attempt to use the single-use invite token a second time
      const secondClient = newClient();
      const { data, error, response } = await secondClient.raw.POST(
        '/v1/auth/join',
        {
          body: {
            invite_token: invite.token,
            display_name: 'Imposter',
            device: {
              name: 'Other Phone',
              platform: 'android',
            },
          },
        },
      );

      expect(response.status).toBe(410);
      expect(data).toBeUndefined();
      assertErrorResponse(error);
    });

    it('handles non-existent / unknown invite token (returns 410 or 400 per OpenAPI spec)', async () => {
      // Note on choice: OpenAPI defines 410 (Invite expired or already used) and 400 (BadRequest).
      // Since ttl_seconds minimum is 60s, an unknown token may be treated either as an expired/invalid
      // invite (410) or a malformed request (400). We assert status is either 410 or 400 with a valid error body.
      const client = newClient();
      const { data, error, response } = await client.raw.POST('/v1/auth/join', {
        body: {
          invite_token: 'UNKNOWNINVITETOKEN9999999999999',
          display_name: 'Unknown Guest',
          device: {
            name: 'Device',
            platform: 'android',
          },
        },
      });

      expect([400, 410]).toContain(response.status);
      expect(data).toBeUndefined();
      assertErrorResponse(error);
    });

    it('returns 400 when display_name is too long (> 40 chars)', async () => {
      const { client: leadClient } = await createStore();

      const inviteRes = await leadClient.raw.POST('/v1/invites', {
        body: { role: 'seller', ttl_seconds: 600 },
      });
      expect(inviteRes.response.status).toBe(201);

      const client = newClient();
      const tooLongName = 'A'.repeat(41);
      const { data, error, response } = await client.raw.POST('/v1/auth/join', {
        body: {
          invite_token: inviteRes.data!.token,
          display_name: tooLongName,
          device: {
            name: 'Device',
            platform: 'android',
          },
        },
      });

      expect(response.status).toBe(400);
      expect(data).toBeUndefined();
      assertErrorResponse(error, 'validation_failed');
    });
  });

  describe('Session Refresh & Token Rotation (/v1/auth/refresh)', () => {
    it('rotates refresh token and revokes session if old refresh token is reused', async () => {
      const { session: s0 } = await createStore();
      const client = newClient();

      // First refresh: S0 -> S1
      const refresh1Res = await client.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: s0.refresh_token },
      });

      expect(refresh1Res.response.status).toBe(200);
      expect(refresh1Res.data).toBeDefined();
      assertAuthSession(refresh1Res.data!);
      const s1 = refresh1Res.data!;

      // Token rotation requirement: new refresh token differs from old
      expect(s1.refresh_token).not.toBe(s0.refresh_token);

      // Attempting to reuse old refresh token S0 must return 401
      const reuseRes = await client.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: s0.refresh_token },
      });
      expect(reuseRes.response.status).toBe(401);
      assertErrorResponse(reuseRes.error);

      // Theft signal protection: reuse attempt must have revoked the whole session!
      // Thus, attempting refresh with the newest refresh token (S1) must now also fail with 401.
      const newestRefreshRes = await client.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: s1.refresh_token },
      });
      expect(newestRefreshRes.response.status).toBe(401);
      assertErrorResponse(newestRefreshRes.error);
    });
  });

  describe('Logout (/v1/auth/logout)', () => {
    it('revokes current session with 204; subsequent refresh returns 401', async () => {
      const { client, session } = await createStore();

      const logoutRes = await client.raw.POST('/v1/auth/logout');
      expect(logoutRes.response.status).toBe(204);

      // Refresh using revoked session refresh token must fail with 401
      const unauthClient = newClient();
      const refreshRes = await unauthClient.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: session.refresh_token },
      });
      expect(refreshRes.response.status).toBe(401);
      assertErrorResponse(refreshRes.error);

      // Accessing authenticated endpoints with the logged-out token returns 401
      const meRes = await client.raw.GET('/v1/me');
      expect(meRes.response.status).toBe(401);
      assertErrorResponse(meRes.error);
    });
  });

  describe('Account Recovery (/v1/auth/recover)', () => {
    it('recovers with valid code returning new session and new recovery code; old code returns 401', async () => {
      const { session: s0, recoveryCode: r0 } = await createStore();
      const client = newClient();

      const recover1Res = await client.raw.POST('/v1/auth/recover', {
        body: {
          recovery_code: r0,
          device: {
            name: 'New Phone',
            platform: 'ios',
            app_version: '1.0.0',
          },
          revoke_other_sessions: false,
        },
      });

      expect(recover1Res.response.status).toBe(200);
      expect(recover1Res.data).toBeDefined();
      assertAuthSession(recover1Res.data!);
      const r1 = recover1Res.data!.recovery_code;
      expect(r1).toMatch(RECOVERY_CODE_REGEX);
      expect(r1).not.toBe(r0);

      // Old recovery code R0 must now fail with 401
      const reuseCodeRes = await client.raw.POST('/v1/auth/recover', {
        body: {
          recovery_code: r0,
          device: {
            name: 'Third Phone',
            platform: 'android',
          },
        },
      });
      expect(reuseCodeRes.response.status).toBe(401);
      assertErrorResponse(reuseCodeRes.error);

      // Since revoke_other_sessions was false, s0 can still refresh
      const s0RefreshRes = await client.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: s0.refresh_token },
      });
      expect(s0RefreshRes.response.status).toBe(200);
    });

    it('revoke_other_sessions=true revokes other sessions on recovery', async () => {
      const { session: s0, recoveryCode: r0 } = await createStore();
      const client = newClient();

      const recoverRes = await client.raw.POST('/v1/auth/recover', {
        body: {
          recovery_code: r0,
          device: {
            name: 'Recovery Phone',
            platform: 'android',
          },
          revoke_other_sessions: true,
        },
      });

      expect(recoverRes.response.status).toBe(200);
      assertAuthSession(recoverRes.data!);

      // Old session s0's refresh must now return 401
      const refreshRes = await client.raw.POST('/v1/auth/refresh', {
        body: { refresh_token: s0.refresh_token },
      });
      expect(refreshRes.response.status).toBe(401);
      assertErrorResponse(refreshRes.error);
    });
  });

  describe('PIN & Counter Phone Member Switching (/v1/me/pin, /v1/auth/switch)', () => {
    it('sets PIN with 204, reflects has_pin=true in /v1/me, and allows switching with correct PIN', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: sellerSession } =
        await joinAsSeller(leadClient);

      // Seller sets 4-digit PIN
      const setPinRes = await sellerClient.raw.PUT('/v1/me/pin', {
        body: { pin: '1234' },
      });
      expect(setPinRes.response.status).toBe(204);

      // Verify GET /v1/me shows has_pin === true
      const meRes = await sellerClient.raw.GET('/v1/me');
      expect(meRes.response.status).toBe(200);
      expect(meRes.data?.member.has_pin).toBe(true);

      // Lead switches to the seller with wrong PIN -> 401
      const wrongPinRes = await leadClient.raw.POST('/v1/auth/switch', {
        body: {
          member_id: sellerSession.member.id,
          pin: '9999',
        },
      });
      expect(wrongPinRes.response.status).toBe(401);
      assertErrorResponse(wrongPinRes.error);

      // Lead switches to the seller with correct PIN -> 200
      const correctPinRes = await leadClient.raw.POST('/v1/auth/switch', {
        body: {
          member_id: sellerSession.member.id,
          pin: '1234',
        },
      });
      expect(correctPinRes.response.status).toBe(200);
      assertAuthSession(correctPinRes.data!);
      expect(correctPinRes.data!.member.id).toBe(sellerSession.member.id);
    });

    it('rejects switch to member with a PIN when no pin is supplied with 401', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: sellerSession } =
        await joinAsSeller(leadClient);

      // Seller sets PIN
      await sellerClient.raw.PUT('/v1/me/pin', { body: { pin: '5678' } });

      // Attempt switch without supplying pin
      const res = await leadClient.raw.POST('/v1/auth/switch', {
        body: {
          member_id: sellerSession.member.id,
          pin: undefined as unknown as string,
        },
      });
      expect(res.response.status).toBe(401);
      assertErrorResponse(res.error);
    });

    it('locks out member after 5 wrong PIN attempts, returning 429 even for correct PIN', async () => {
      const { client: leadClient } = await createStore();
      const { client: sellerClient, session: sellerSession } =
        await joinAsSeller(leadClient);

      await sellerClient.raw.PUT('/v1/me/pin', { body: { pin: '7890' } });

      // 5 consecutive wrong PIN attempts
      for (let i = 0; i < 5; i++) {
        const res = await leadClient.raw.POST('/v1/auth/switch', {
          body: {
            member_id: sellerSession.member.id,
            pin: '0000',
          },
        });
        expect(res.response.status).toBe(401);
        assertErrorResponse(res.error);
      }

      // 6th attempt with the CORRECT PIN must be rate-limited (429)
      const lockedRes = await leadClient.raw.POST('/v1/auth/switch', {
        body: {
          member_id: sellerSession.member.id,
          pin: '7890',
        },
      });
      expect(lockedRes.response.status).toBe(429);
      expect(lockedRes.response.headers.get('retry-after')).toBeDefined();
      assertErrorResponse(lockedRes.error);
    });

    it('rejects invalid PIN formats with 400', async () => {
      const { client } = await createStore();

      // PIN must be 4 to 6 digits; "12" is too short
      const res = await client.raw.PUT('/v1/me/pin', {
        body: { pin: '12' },
      });
      expect(res.response.status).toBe(400);
      assertErrorResponse(res.error);
    });

    it('clears PIN when null is supplied in PUT /v1/me/pin', async () => {
      const { client } = await createStore();

      // Set PIN
      const setRes = await client.raw.PUT('/v1/me/pin', {
        body: { pin: '123456' },
      });
      expect(setRes.response.status).toBe(204);

      // Clear PIN with null
      const clearRes = await client.raw.PUT('/v1/me/pin', {
        body: { pin: null },
      });
      expect(clearRes.response.status).toBe(204);

      // Verify has_pin is false
      const meRes = await client.raw.GET('/v1/me');
      expect(meRes.data?.member.has_pin).toBe(false);
    });

    it('returns 404 when switching to unknown member ID', async () => {
      const { client: leadClient } = await createStore();

      const res = await leadClient.raw.POST('/v1/auth/switch', {
        body: {
          member_id: '00000000-0000-0000-0000-000000000000',
          pin: '1234',
        },
      });
      expect(res.response.status).toBe(404);
      assertErrorResponse(res.error);
    });
  });
});
