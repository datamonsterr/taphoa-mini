-- Retain the proposing tool span so later action decisions can link to it.
ALTER TABLE assistant_actions ADD COLUMN span_id TEXT;
ALTER TABLE assistant_messages ADD COLUMN span_id TEXT;
