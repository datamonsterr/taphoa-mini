-- 3.4 Recognition data
CREATE TABLE scans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    image_id        UUID NOT NULL REFERENCES images,
    member_id       UUID NOT NULL REFERENCES members,
    mode            TEXT NOT NULL CHECK (mode IN ('single', 'multi')),
    purpose         TEXT NOT NULL CHECK (purpose IN ('checkout', 'enrollment')),
    segmenter       TEXT NOT NULL,                          -- sam-vit-b-onnx@1
    embedder        TEXT NOT NULL,
    catalog_version BIGINT NOT NULL,                        -- change_log seq at scan time
    timings         JSONB NOT NULL,                         -- {segment, embed, search, total} ms
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scans_store_created ON scans (store_id, created_at DESC);

CREATE TABLE detections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id      UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    scan_id       UUID NOT NULL REFERENCES scans ON DELETE CASCADE,
    position      SMALLINT NOT NULL,
    bbox          REAL[] NOT NULL CHECK (array_length(bbox, 1) = 4),
    score         REAL NOT NULL,
    area          INT NOT NULL,
    crop_image_id UUID REFERENCES images,
    embedding     vector(384),
    match         TEXT NOT NULL CHECK (match IN ('matched', 'ambiguous', 'unknown')),
    candidates    JSONB NOT NULL,                           -- [{product_id, similarity}] at scan time
    UNIQUE (scan_id, position)
);
