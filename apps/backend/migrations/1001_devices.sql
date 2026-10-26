CREATE TABLE devices (
    token TEXT PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    app_version TEXT NOT NULL CHECK (length(app_version) > 0),
    language TEXT NOT NULL CHECK (language IN ('vi', 'en')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_store_member_idx ON devices (store_id, member_id);

-- Tokens intentionally have no FK: ticket history survives device unregistration.
CREATE TABLE push_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    token TEXT NOT NULL,
    business_date DATE NOT NULL,
    ticket_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'pending_receipt', 'receipt_ok', 'receipt_error')),
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_at TIMESTAMPTZ
);
CREATE INDEX push_tickets_status_created_idx ON push_tickets (status, created_at);
CREATE INDEX push_tickets_store_date_idx ON push_tickets (store_id, business_date);
