-- Status lookup for drafts and the recent-confirmation window for margin chips.
CREATE INDEX receipts_store_status_confirmed ON receipts (store_id, status, confirmed_at DESC);
