-- 3.8 Sync and events
CREATE TABLE change_log (
    seq        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    entity     TEXT NOT NULL CHECK (entity IN ('store', 'member', 'category', 'product')),
    entity_id  UUID NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX change_log_store_seq ON change_log (store_id, seq);

CREATE TABLE outbox_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    type         TEXT NOT NULL,
    payload      JSONB NOT NULL,                            -- full envelope, see §5.2
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox_events (id) WHERE published_at IS NULL;
