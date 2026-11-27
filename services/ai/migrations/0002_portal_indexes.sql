-- The portal's request log filtered by key: `where key_id = $1 order by id desc`. It also
-- indexes the foreign key to api_keys.
create index requests_key_id on requests (key_id, id desc);

-- One user's rows in a time window: the stats endpoint for a member or one user, and each
-- key's last-30-day totals in the key list. `requests_sub_id` orders by id, not time.
create index requests_sub_at on requests (sub, at);
