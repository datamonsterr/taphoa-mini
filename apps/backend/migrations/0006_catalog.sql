-- 3.3 Catalog
-- Requires unaccent and pg_trgm for accent-insensitive trigram search.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE wrapper around unaccent() (which is only STABLE) so it can back a GIN index.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$
    SELECT public.unaccent($1);
$$;

CREATE TABLE categories (
    id         UUID PRIMARY KEY,
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    version    BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_store_name ON categories (store_id, lower(name));

CREATE TABLE products (
    id           UUID PRIMARY KEY,                          -- client UUIDv7
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    name         TEXT CHECK (char_length(name) <= 120),
    base_unit    TEXT NOT NULL DEFAULT 'cái',
    price        BIGINT NOT NULL CHECK (price >= 0),
    cost_price   BIGINT CHECK (cost_price >= 0),
    barcode      TEXT,
    category_id  UUID REFERENCES categories,
    archived     BOOLEAN NOT NULL DEFAULT false,
    version      BIGINT NOT NULL DEFAULT 1,
    request_hash BYTEA NOT NULL,
    created_by   UUID NOT NULL REFERENCES members,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_store ON products (store_id) WHERE NOT archived;
CREATE UNIQUE INDEX products_store_barcode ON products (store_id, barcode) WHERE barcode IS NOT NULL;
-- Accent-insensitive trigram search: "hao hao" -> "Hảo Hảo".
CREATE INDEX products_name_trgm ON products USING gin (immutable_unaccent(lower(name)) gin_trgm_ops);

CREATE TABLE product_units (
    id               UUID PRIMARY KEY,
    store_id         UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id       UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    name             TEXT NOT NULL,                         -- lốc, thùng
    quantity_in_base INT NOT NULL CHECK (quantity_in_base >= 2),
    price            BIGINT NOT NULL CHECK (price >= 0),
    barcode          TEXT,
    UNIQUE (product_id, name)
);
CREATE UNIQUE INDEX product_units_store_barcode ON product_units (store_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE product_images (
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    image_id   UUID NOT NULL REFERENCES images,
    position   SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, image_id),
    UNIQUE (product_id, position)
);

CREATE TABLE product_embeddings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id     UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id   UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    image_id     UUID NOT NULL REFERENCES images,
    detection_id UUID,                                      -- crop source, when from a scan
    model        TEXT NOT NULL,                             -- e.g. dinov2-vits14-onnx@1
    embedding    vector(384) NOT NULL,                      -- L2-normalized
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_embeddings_hnsw ON product_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX product_embeddings_store ON product_embeddings (store_id, model);

CREATE TABLE price_history (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id   UUID NOT NULL REFERENCES stores ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products ON DELETE CASCADE,
    unit_id    UUID REFERENCES product_units ON DELETE SET NULL,
    field      TEXT NOT NULL CHECK (field IN ('price', 'cost_price', 'unit_price')),
    old_value  BIGINT,
    new_value  BIGINT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('manual', 'margin_alert', 'purchase')),
    changed_by UUID NOT NULL REFERENCES members,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_history_product ON price_history (product_id, changed_at DESC);
