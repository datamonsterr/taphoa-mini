-- 3.1 Tenancy and identity
-- Extend stores (0001 created id, name, created_at only).
-- recovery_code_hash is NOT NULL: add with DEFAULT '' then drop the default so existing rows survive.
ALTER TABLE stores
    ADD COLUMN bank_bin             TEXT CHECK (bank_bin ~ '^[0-9]{6}$'),
    ADD COLUMN bank_short_name      TEXT,
    ADD COLUMN bank_account_number  TEXT CHECK (bank_account_number ~ '^[0-9A-Za-z]{4,19}$'),
    ADD COLUMN bank_account_name    TEXT CHECK (char_length(bank_account_name) <= 50),
    ADD COLUMN margin_threshold_pct NUMERIC(5,2) NOT NULL DEFAULT 0
                                    CHECK (margin_threshold_pct BETWEEN 0 AND 100),
    ADD COLUMN sales_memo_prefix    TEXT NOT NULL DEFAULT 'TH' CHECK (char_length(sales_memo_prefix) <= 8),
    ADD COLUMN recovery_code_hash   TEXT NOT NULL DEFAULT '',
    ADD COLUMN version              BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD CONSTRAINT bank_all_or_none CHECK (
        (bank_bin IS NULL) = (bank_account_number IS NULL)
        AND (bank_bin IS NULL) = (bank_account_name IS NULL));

-- Drop the placeholder default so future inserts must supply the real Argon2id hash.
ALTER TABLE stores ALTER COLUMN recovery_code_hash DROP DEFAULT;

CREATE TABLE members (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
    role         TEXT NOT NULL CHECK (role IN ('lead', 'seller')),
    can_enroll   BOOLEAN NOT NULL DEFAULT false,
    pin_hash     TEXT,                                      -- Argon2id, null = no PIN
    active       BOOLEAN NOT NULL DEFAULT true,
    version      BIGINT NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX members_store ON members (store_id) WHERE active;
-- "at least one active lead" is enforced in the handler inside the transaction
-- (SELECT ... FOR UPDATE on the store's lead rows).

CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id            UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id           UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    device_name         TEXT NOT NULL,
    platform            TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
    app_version         TEXT,
    refresh_token_hash  BYTEA NOT NULL UNIQUE,               -- SHA-256 of current token
    previous_token_hash BYTEA,                               -- reuse detection
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_member ON sessions (member_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_previous ON sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

CREATE TABLE invites (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('lead', 'seller')),
    can_enroll BOOLEAN NOT NULL DEFAULT false,
    created_by UUID NOT NULL REFERENCES members,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    used_by    UUID REFERENCES members,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
