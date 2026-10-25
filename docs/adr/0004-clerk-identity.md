# ADR 0004: Clerk for identity, store membership stays in our database

Status: Accepted · Date: 2026-10-25

## Context

The app has its own auth: store creation returns a recovery code, devices hold access and
refresh tokens, sellers join with invite codes and switch on a shared phone with a PIN. We
want real per-person identity so that traces, logs and product analytics represent people,
and we do not want to keep building account recovery ourselves. The owner does not own a
domain yet, and Clerk production instances require one.

## Decision

- Clerk authenticates people (email verification code and Google SSO). Every API request
  carries a Clerk session JWT; the backend verifies it against the instance JWKS. The `sub`
  claim (Clerk user id) is the person identity everywhere, including telemetry.
- Stores, members, roles, `can_enroll`, invites and the permission matrix stay in Postgres.
  A Clerk user creates a store or redeems an invite code to become a member. Clerk
  Organizations are not used.
- Shared counter phones use Clerk multi-session: each member signs in once on the device and
  switches from a list. A per-member PIN lock stays as a quick lock before switching.
- Our refresh tokens, device sessions, recovery codes and `switchMember` are removed. Existing
  data is reset and reseeded (no real users exist yet).
- Both Railway environments use one Clerk development instance until a domain exists.

## Considered options

- Clerk Organizations as the store model: rejected; it duplicates our role matrix and
  `can_enroll`, adds plan limits and ties store data to the vendor.
- Keeping our own auth and only tagging telemetry with member ids: rejected by the owner;
  they want real accounts and managed recovery.

## Consequences

- The dev instance shows a development badge and has a user cap. Moving to production needs a
  domain, a Clerk production instance, new keys and registered native app identifiers.
- E2E tests create users with `+clerk_test` emails (code `424242`) and Clerk testing tokens.
- One Clerk user can belong to several stores, so the client selects the store per request.
