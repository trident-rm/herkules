-- API keys. Only the SHA-256 of a key is stored; `prefix` is its first characters, for display.
create table api_keys (
  id bigserial primary key,
  sub text not null,
  name text not null,
  hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_sub on api_keys (sub);

-- Tunnel backends added in the portal. Backends from AI_BACKENDS_FILE are not stored here.
create table backends (
  name text primary key,
  hostname text not null unique,
  port integer not null check (port between 1 and 65535),
  models text[] not null,
  tunnel_id text not null,
  dns_record_id text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- Admin state for any backend, by name. A backend without a row is enabled.
create table backend_state (
  name text primary key,
  state text not null check (state in ('enabled', 'disabled', 'draining')),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- Logging-level overrides: per user (`sub`) and per model.
create table log_levels (
  scope text not null check (scope in ('user', 'model')),
  subject text not null,
  level text not null check (level in ('metadata', 'full')),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (scope, subject)
);

-- One row per forwarded request.
create table requests (
  id bigserial primary key,
  at timestamptz not null,
  sub text not null,
  key_id bigint not null references api_keys (id),
  model text,
  backend text,
  method text not null,
  route text not null,
  status integer not null,
  duration_ms integer not null,
  streamed boolean not null,
  cancelled boolean not null,
  effort text,
  -- An upstream error, including an error object in a 200 body, or the gateway's own.
  error text,
  prompt_tokens bigint,
  cached_tokens bigint,
  output_tokens bigint,
  ttft_ms double precision,
  decode_tps double precision,
  tokens_per_round double precision,
  level text not null check (level in ('metadata', 'full'))
);
create index requests_sub_id on requests (sub, id desc);
create index requests_at on requests (at);

-- Request and response bodies of `full` requests, zstd-compressed, each capped before compression.
create table request_bodies (
  request_id bigint primary key references requests (id) on delete cascade,
  at timestamptz not null,
  request bytea not null,
  request_bytes integer not null,
  request_truncated boolean not null,
  response bytea not null,
  response_bytes integer not null,
  response_truncated boolean not null
);
create index request_bodies_at on request_bodies (at);
