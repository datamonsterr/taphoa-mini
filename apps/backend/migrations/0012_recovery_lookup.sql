-- A recovery code is uppercase with hyphens/spaces removed before hashing.
-- SHA-256 lookup selects a candidate; Argon2id verification still authenticates it.
ALTER TABLE stores ADD COLUMN recovery_code_lookup BYTEA UNIQUE;
