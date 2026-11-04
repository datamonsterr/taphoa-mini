-- Server-side PIN lock for Clerk sessions on a shared phone.
-- A person with a PIN is only served while their session is unlocked. `locked` is set by
-- POST /v1/me/pin/lock (the app calls it when another person becomes active or the device
-- locks); only POST /v1/me/pin/verify with the right PIN (or setting a PIN) clears it. A session
-- first seen by the API starts unlocked, because creating a session needs a full sign-in.
-- `touched_at` slides with use; an unlocked session idle for too long is locked again.
CREATE TABLE session_pin_state (
    session_id    TEXT PRIMARY KEY,
    clerk_user_id TEXT NOT NULL,
    locked        BOOLEAN NOT NULL DEFAULT false,
    touched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_pin_state_touched_idx ON session_pin_state (touched_at);
