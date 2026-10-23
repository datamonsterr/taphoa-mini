-- E6: change_log compaction floor (cursors below it get 410) and outbox retention index.
CREATE TABLE change_log_floor (
    store_id  UUID PRIMARY KEY REFERENCES stores ON DELETE CASCADE,
    floor_seq BIGINT NOT NULL
);
CREATE INDEX outbox_published_at ON outbox_events (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX change_log_created ON change_log (created_at);
