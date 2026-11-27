//! Every query the gateway runs against its own database.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};

use crate::{backends::State, usage::Stats};

pub async fn connect(url: &str, connections: u32) -> Result<PgPool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(connections)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub id: i64,
    pub name: String,
    pub prefix: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, FromRow)]
pub struct KeyOwner {
    pub id: i64,
    pub sub: String,
}

pub async fn create_key(
    db: &PgPool,
    sub: &str,
    name: &str,
    hash: &str,
    prefix: &str,
) -> sqlx::Result<Key> {
    sqlx::query_as(
        "insert into api_keys (sub, name, hash, prefix) values ($1, $2, $3, $4)
         returning id, name, prefix, created_at, last_used_at",
    )
    .bind(sub)
    .bind(name)
    .bind(hash)
    .bind(prefix)
    .fetch_one(db)
    .await
}

pub async fn keys(db: &PgPool, sub: &str) -> sqlx::Result<Vec<Key>> {
    sqlx::query_as(
        "select id, name, prefix, created_at, last_used_at from api_keys
         where sub = $1 and revoked_at is null order by id",
    )
    .bind(sub)
    .fetch_all(db)
    .await
}

/// Revokes one of `sub`'s keys; false when it has no such active key.
pub async fn revoke_key(db: &PgPool, sub: &str, id: i64) -> sqlx::Result<bool> {
    let done = sqlx::query(
        "update api_keys set revoked_at = now() where id = $1 and sub = $2 and revoked_at is null",
    )
    .bind(id)
    .bind(sub)
    .execute(db)
    .await?;
    Ok(done.rows_affected() == 1)
}

pub async fn key_owner(db: &PgPool, hash: &str) -> sqlx::Result<Option<KeyOwner>> {
    sqlx::query_as("select id, sub from api_keys where hash = $1 and revoked_at is null")
        .bind(hash)
        .fetch_optional(db)
        .await
}

/// Records use at most once a minute per key.
pub async fn touch_key(db: &PgPool, id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "update api_keys set last_used_at = now()
         where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Clone, Debug, FromRow)]
pub struct TunnelBackend {
    pub name: String,
    pub hostname: String,
    pub port: i32,
    pub models: Vec<String>,
    pub tunnel_id: String,
    pub dns_record_id: String,
}

pub async fn tunnel_backends(db: &PgPool) -> sqlx::Result<Vec<TunnelBackend>> {
    sqlx::query_as(
        "select name, hostname, port, models, tunnel_id, dns_record_id from backends order by name",
    )
    .fetch_all(db)
    .await
}

pub async fn insert_tunnel_backend(db: &PgPool, row: &TunnelBackend, by: &str) -> sqlx::Result<()> {
    sqlx::query(
        "insert into backends (name, hostname, port, models, tunnel_id, dns_record_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&row.name)
    .bind(&row.hostname)
    .bind(row.port)
    .bind(&row.models)
    .bind(&row.tunnel_id)
    .bind(&row.dns_record_id)
    .bind(by)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete_tunnel_backend(db: &PgPool, name: &str) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("delete from backends where name = $1")
        .bind(name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from backend_state where name = $1")
        .bind(name)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

pub async fn backend_states(db: &PgPool) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as("select name, state from backend_state")
        .fetch_all(db)
        .await
}

pub async fn set_backend_state(
    db: &PgPool,
    name: &str,
    state: State,
    by: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "insert into backend_state (name, state, updated_by) values ($1, $2, $3)
         on conflict (name) do update set state = $2, updated_by = $3, updated_at = now()",
    )
    .bind(name)
    .bind(state.as_str())
    .bind(by)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn log_levels(db: &PgPool) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as("select scope, subject, level from log_levels")
        .fetch_all(db)
        .await
}

/// Sets or, with `None`, clears one override.
pub async fn set_log_level(
    db: &PgPool,
    scope: &str,
    subject: &str,
    level: Option<&str>,
    by: &str,
) -> sqlx::Result<()> {
    match level {
        Some(level) => sqlx::query(
            "insert into log_levels (scope, subject, level, updated_by) values ($1, $2, $3, $4)
             on conflict (scope, subject) do update set level = $3, updated_by = $4, updated_at = now()",
        )
        .bind(scope)
        .bind(subject)
        .bind(level)
        .bind(by),
        None => sqlx::query("delete from log_levels where scope = $1 and subject = $2")
            .bind(scope)
            .bind(subject),
    }
    .execute(db)
    .await?;
    Ok(())
}

/// A finished request, ready to write.
pub struct NewRequest {
    pub at: DateTime<Utc>,
    pub sub: String,
    pub key_id: i64,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub method: String,
    pub route: String,
    pub status: i32,
    pub duration_ms: i32,
    pub streamed: bool,
    pub cancelled: bool,
    pub effort: Option<String>,
    pub stats: Stats,
    pub level: &'static str,
}

pub struct NewBodies {
    pub request: Vec<u8>,
    pub request_bytes: i32,
    pub request_truncated: bool,
    pub response: Vec<u8>,
    pub response_bytes: i32,
    pub response_truncated: bool,
}

pub async fn insert_request(
    db: &PgPool,
    row: &NewRequest,
    bodies: Option<&NewBodies>,
) -> sqlx::Result<i64> {
    let mut tx = db.begin().await?;
    let (id,): (i64,) = sqlx::query_as(
        "insert into requests (at, sub, key_id, model, backend, method, route, status, duration_ms,
           streamed, cancelled, effort, prompt_tokens, cached_tokens, output_tokens, ttft_ms,
           decode_tps, tokens_per_round, level)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         returning id",
    )
    .bind(row.at)
    .bind(&row.sub)
    .bind(row.key_id)
    .bind(&row.model)
    .bind(&row.backend)
    .bind(&row.method)
    .bind(&row.route)
    .bind(row.status)
    .bind(row.duration_ms)
    .bind(row.streamed)
    .bind(row.cancelled)
    .bind(&row.effort)
    .bind(row.stats.prompt_tokens)
    .bind(row.stats.cached_tokens)
    .bind(row.stats.output_tokens)
    .bind(row.stats.ttft_ms)
    .bind(row.stats.decode_tps)
    .bind(row.stats.tokens_per_round)
    .bind(row.level)
    .fetch_one(&mut *tx)
    .await?;
    if let Some(b) = bodies {
        sqlx::query(
            "insert into request_bodies (request_id, at, request, request_bytes, request_truncated,
               response, response_bytes, response_truncated)
             values ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(id)
        .bind(row.at)
        .bind(&b.request)
        .bind(b.request_bytes)
        .bind(b.request_truncated)
        .bind(&b.response)
        .bind(b.response_bytes)
        .bind(b.response_truncated)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    pub id: i64,
    pub at: DateTime<Utc>,
    pub sub: String,
    pub key_name: Option<String>,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub method: String,
    pub route: String,
    pub status: i32,
    pub duration_ms: i32,
    pub streamed: bool,
    pub cancelled: bool,
    pub effort: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub tokens_per_round: Option<f64>,
    pub level: String,
    pub has_body: bool,
}

/// Newest first, before `before` when given; only `sub`'s when given.
pub async fn requests(
    db: &PgPool,
    sub: Option<&str>,
    before: Option<i64>,
    limit: i64,
) -> sqlx::Result<Vec<RequestRow>> {
    sqlx::query_as(
        "select r.id, r.at, r.sub, k.name as key_name, r.model, r.backend, r.method, r.route,
           r.status, r.duration_ms, r.streamed, r.cancelled, r.effort, r.prompt_tokens,
           r.cached_tokens, r.output_tokens, r.ttft_ms, r.decode_tps, r.tokens_per_round, r.level,
           exists (select 1 from request_bodies b where b.request_id = r.id) as has_body
         from requests r left join api_keys k on k.id = r.key_id
         where ($1::text is null or r.sub = $1) and ($2::bigint is null or r.id < $2)
         order by r.id desc limit $3",
    )
    .bind(sub)
    .bind(before)
    .bind(limit)
    .fetch_all(db)
    .await
}

#[derive(FromRow)]
pub struct BodyRow {
    pub sub: String,
    pub request: Vec<u8>,
    pub request_bytes: i32,
    pub request_truncated: bool,
    pub response: Vec<u8>,
    pub response_bytes: i32,
    pub response_truncated: bool,
}

pub async fn bodies(db: &PgPool, id: i64) -> sqlx::Result<Option<BodyRow>> {
    sqlx::query_as(
        "select r.sub, b.request, b.request_bytes, b.request_truncated, b.response,
           b.response_bytes, b.response_truncated
         from request_bodies b join requests r on r.id = b.request_id where b.request_id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: NaiveDate,
    pub sub: String,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub cached_tokens: i64,
    pub output_tokens: i64,
}

/// Requests and tokens per UTC day and user over the last `days` days, only `sub`'s when given.
pub async fn usage(db: &PgPool, sub: Option<&str>, days: i32) -> sqlx::Result<Vec<UsageDay>> {
    sqlx::query_as(
        "select (at at time zone 'UTC')::date as day, sub, count(*) as requests,
           coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
           coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
           coalesce(sum(output_tokens), 0)::bigint as output_tokens
         from requests
         where at > now() - make_interval(days => $2) and ($1::text is null or sub = $1)
         group by 1, 2 order by 1, 2",
    )
    .bind(sub)
    .bind(days)
    .fetch_all(db)
    .await
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Performance {
    pub model: Option<String>,
    pub backend: Option<String>,
    pub requests: i64,
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub tokens_per_round: Option<f64>,
}

/// Median TTFT, decode speed and tokens per round per model and backend, over successful
/// generations of the last `hours` hours.
pub async fn performance(db: &PgPool, hours: i32) -> sqlx::Result<Vec<Performance>> {
    sqlx::query_as(
        "select model, backend, count(*) as requests,
           percentile_cont(0.5) within group (order by ttft_ms) as ttft_ms,
           percentile_cont(0.5) within group (order by decode_tps) as decode_tps,
           percentile_cont(0.5) within group (order by tokens_per_round) as tokens_per_round
         from requests
         where at > now() - make_interval(hours => $1) and status < 400 and output_tokens > 0
         group by 1, 2 order by 1, 2",
    )
    .bind(hours)
    .fetch_all(db)
    .await
}

pub async fn purge_bodies(db: &PgPool, days: i32) -> sqlx::Result<u64> {
    let done =
        sqlx::query("delete from request_bodies where at < now() - make_interval(days => $1)")
            .bind(days)
            .execute(db)
            .await?;
    Ok(done.rows_affected())
}
