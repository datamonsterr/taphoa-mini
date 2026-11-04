-- Clearing a product's cost price is a price change too: its history row has no new value.
ALTER TABLE price_history ALTER COLUMN new_value DROP NOT NULL;
ALTER TABLE price_history
    ADD CONSTRAINT price_history_new_value_required
    CHECK (new_value IS NOT NULL OR field = 'cost_price');
