-- V1 voice: utterance log (transcript, parse, draft, outcome), learned aliases, and the
-- `voice` sale line source. Audio bytes are never stored here.
CREATE TABLE voice_utterances (
    id          UUID PRIMARY KEY,
    store_id    UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member      UUID NOT NULL REFERENCES members,
    mode        TEXT NOT NULL CHECK (mode IN ('sale', 'transcribe')),
    language    TEXT NOT NULL DEFAULT 'vi',
    entry       TEXT,
    intent      TEXT NOT NULL CHECK (intent IN ('sale', 'chat', 'none')),
    transcript  TEXT NOT NULL,
    parsed      JSONB,
    draft       JSONB,
    model       TEXT NOT NULL,
    stt_fallback BOOLEAN NOT NULL DEFAULT false,
    latency_ms  INT NOT NULL,
    outcome     TEXT CHECK (outcome IN ('confirmed', 'edited', 'abandoned')),
    stage       TEXT CHECK (stage IN ('listening', 'draft', 'pay')),
    sale_id     UUID,
    corrections JSONB,
    outcome_at  TIMESTAMPTZ,
    learned_at  TIMESTAMPTZ,
    donated     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX voice_utterances_store_created ON voice_utterances (store_id, created_at DESC);
CREATE INDEX voice_utterances_created ON voice_utterances (created_at) WHERE NOT donated;

-- `hits` counts agreeing corrections of one phrase; lookups use rows with hits >= 2.
CREATE TABLE voice_aliases (
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    phrase     TEXT NOT NULL,
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    hits       INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, phrase)
);

ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_source_check;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_source_check
    CHECK (source IN ('camera', 'multi_photo', 'barcode', 'grid', 'manual', 'voice'));
