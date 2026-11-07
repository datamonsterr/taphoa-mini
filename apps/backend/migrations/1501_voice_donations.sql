-- This deletion ledger intentionally survives store/utterance deletion so audio cannot
-- become unreachable when a store is removed.
CREATE TABLE voice_donations (
    utterance_id UUID PRIMARY KEY,
    store_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX voice_donations_created ON voice_donations (created_at);
INSERT INTO voice_donations (utterance_id, store_id, created_at)
SELECT id, store_id, created_at FROM voice_utterances WHERE donated;
