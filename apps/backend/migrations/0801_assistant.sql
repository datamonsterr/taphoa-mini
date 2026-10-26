-- X3 assistant: threads, messages, proposed actions and feedback.
-- A thread belongs to one member; every query is scoped by store_id and member_id.
CREATE TABLE assistant_threads (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id  UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    title      TEXT,
    context    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_threads_member ON assistant_threads (store_id, member_id, updated_at DESC, id DESC);

CREATE TABLE assistant_messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id     UUID NOT NULL REFERENCES assistant_threads ON DELETE CASCADE,
    store_id      UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content       TEXT NOT NULL,
    attachments   JSONB NOT NULL DEFAULT '[]',
    -- Summaries shown to clients: [{call_id, tool, ok, summary_vi}].
    tool_calls    JSONB NOT NULL DEFAULT '[]',
    -- Internal model tool calls and tool results, replayed to rebuild the model context.
    transcript    JSONB NOT NULL DEFAULT '[]',
    cards         JSONB NOT NULL DEFAULT '[]',
    model         TEXT,
    input_tokens  INT,
    output_tokens INT,
    trace_id      TEXT,
    status        TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming', 'complete', 'failed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_thread ON assistant_messages (store_id, thread_id, created_at, id);

CREATE TABLE assistant_actions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id             UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    thread_id            UUID NOT NULL REFERENCES assistant_threads ON DELETE CASCADE,
    message_id           UUID NOT NULL REFERENCES assistant_messages ON DELETE CASCADE,
    kind                 TEXT NOT NULL,
    payload              JSONB NOT NULL,
    summary_vi           TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed', 'executing', 'done', 'failed', 'rejected', 'expired')),
    proposed_by          UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    decided_by           UUID REFERENCES members ON DELETE SET NULL,
    decided_at           TIMESTAMPTZ,
    -- SHA-256 of the confirm Idempotency-Key, so a replay can be told from a second decision.
    idempotency_key_hash BYTEA,
    result               JSONB,
    error                JSONB,
    trace_id             TEXT,
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_actions_thread ON assistant_actions (store_id, thread_id, created_at);

CREATE TABLE assistant_feedback (
    message_id UUID NOT NULL REFERENCES assistant_messages ON DELETE CASCADE,
    member_id  UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    rating     TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    comment    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, member_id)
);
CREATE INDEX assistant_feedback_store ON assistant_feedback (store_id, member_id);
