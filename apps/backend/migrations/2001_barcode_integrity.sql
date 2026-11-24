-- Lock both source tables throughout backfill and trigger installation so no write
-- can escape the registry. Existing duplicate groups are counted, not modified.
LOCK TABLE products, product_units IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION canonical_barcode(code text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN code ~ '^0[0-9]{12}$' THEN substring(code FROM 2) ELSE code END
$$;

CREATE TABLE barcode_registry (
    store_id uuid NOT NULL,
    canonical_code text NOT NULL,
    entry_count bigint NOT NULL CHECK (entry_count > 0),
    PRIMARY KEY (store_id, canonical_code)
);
INSERT INTO barcode_registry (store_id, canonical_code, entry_count)
SELECT store_id, canonical_barcode(barcode), count(*)
FROM (
    SELECT store_id, barcode FROM products WHERE barcode IS NOT NULL
    UNION ALL
    SELECT store_id, barcode FROM product_units WHERE barcode IS NOT NULL
) entries GROUP BY store_id, canonical_barcode(barcode);

CREATE FUNCTION maintain_barcode_registry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_code text; new_code text;
BEGIN
    IF TG_OP <> 'INSERT' THEN old_code := canonical_barcode(OLD.barcode); END IF;
    IF TG_OP <> 'DELETE' THEN new_code := canonical_barcode(NEW.barcode); END IF;
    IF TG_OP = 'UPDATE' AND OLD.store_id = NEW.store_id AND old_code IS NOT DISTINCT FROM new_code THEN
        RETURN NEW;
    END IF;
    IF old_code IS NOT NULL THEN
        UPDATE barcode_registry SET entry_count = entry_count - 1 WHERE store_id = OLD.store_id AND canonical_code = old_code AND entry_count > 1;
        IF NOT FOUND THEN
            DELETE FROM barcode_registry WHERE store_id = OLD.store_id AND canonical_code = old_code;
        END IF;
    END IF;
    IF new_code IS NOT NULL THEN
        INSERT INTO barcode_registry (store_id, canonical_code, entry_count)
        VALUES (NEW.store_id, new_code, 1);
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER products_barcode_registry BEFORE INSERT OR UPDATE OF barcode, store_id OR DELETE ON products
FOR EACH ROW EXECUTE FUNCTION maintain_barcode_registry();
CREATE TRIGGER product_units_barcode_registry BEFORE INSERT OR UPDATE OF barcode, store_id OR DELETE ON product_units
FOR EACH ROW EXECUTE FUNCTION maintain_barcode_registry();
