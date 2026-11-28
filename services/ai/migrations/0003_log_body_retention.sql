-- An absent row inherits AI_LOG_RETENTION_DAYS. A NULL duration keeps the bodies.
create table log_body_retention (
  model text primary key,
  days integer check (days between 1 and 36500),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
