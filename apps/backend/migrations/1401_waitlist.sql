CREATE TABLE waitlist_signups (
    email text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);
