CREATE TABLE assistant_digests (
    store_id UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    business_date DATE NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source TEXT NOT NULL CHECK (source IN ('model', 'template')),
    model TEXT,
    summary_vi TEXT NOT NULL,
    payload JSONB NOT NULL,
    pushed_at TIMESTAMPTZ,
    PRIMARY KEY (store_id, business_date)
);

CREATE TABLE assistant_digest_reads (
    store_id UUID NOT NULL,
    business_date DATE NOT NULL,
    member_id UUID NOT NULL REFERENCES members ON DELETE CASCADE,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, business_date, member_id),
    FOREIGN KEY (store_id, business_date) REFERENCES assistant_digests ON DELETE CASCADE
);
CREATE INDEX assistant_digest_reads_member_idx ON assistant_digest_reads (member_id);
CREATE INDEX assistant_digests_model_generated_idx ON assistant_digests (generated_at) WHERE source = 'model';
