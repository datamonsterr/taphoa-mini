-- oracle: setup_pending_invite_count
-- kind: count
-- uses: U21
-- describe: Invites that were created and neither used nor expired on the pinned date.
WITH ctx AS (SELECT $1::uuid AS store_id, $2::date AS today)
SELECT COUNT(*)::int AS pending_invites
FROM invites i
JOIN ctx ON ctx.store_id = i.store_id
WHERE i.used_at IS NULL
  AND i.expires_at > ctx.today
