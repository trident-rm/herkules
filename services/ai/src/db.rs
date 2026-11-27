//! Every query the gateway runs against its own database.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{
    FromRow, PgPool, Postgres, QueryBuilder,
    postgres::{PgPoolOptions, PgRow},
};

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
    /// Use over the last 30 days; zero on a key just created.
    #[sqlx(default)]
    pub requests_30d: i64,
    #[sqlx(default)]
    pub prompt_tokens_30d: i64,
    #[sqlx(default)]
    pub cached_tokens_30d: i64,
    #[sqlx(default)]
    pub output_tokens_30d: i64,
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

/// `sub`'s active keys, each with its requests and tokens over the last 30 days.
pub async fn keys(db: &PgPool, sub: &str) -> sqlx::Result<Vec<Key>> {
    sqlx::query_as(
        "select k.id, k.name, k.prefix, k.created_at, k.last_used_at,
           coalesce(u.requests, 0) as requests_30d,
           coalesce(u.prompt_tokens, 0) as prompt_tokens_30d,
           coalesce(u.cached_tokens, 0) as cached_tokens_30d,
           coalesce(u.output_tokens, 0) as output_tokens_30d
         from api_keys k left join (
           select key_id, count(*) as requests,
             coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
             coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
             coalesce(sum(output_tokens), 0)::bigint as output_tokens
           from requests where sub = $1 and at > now() - interval '30 days' group by key_id
         ) u on u.key_id = k.id
         where k.sub = $1 and k.revoked_at is null order by k.id",
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
    pub error: Option<String>,
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
           decode_tps, tokens_per_round, level, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20)
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
    .bind(&row.error)
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
    pub error: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub tokens_per_round: Option<f64>,
    pub level: String,
    pub has_body: bool,
}

const REQUEST_SELECT: &str = "select r.id, r.at, r.sub, k.name as key_name, r.model, r.backend,
   r.method, r.route, r.status, r.duration_ms, r.streamed, r.cancelled, r.effort, r.error,
   r.prompt_tokens, r.cached_tokens, r.output_tokens, r.ttft_ms, r.decode_tps,
   r.tokens_per_round, r.level,
   exists (select 1 from request_bodies b where b.request_id = r.id) as has_body
 from requests r left join api_keys k on k.id = r.key_id";

/// How a request ended, as the portal filters and counts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    /// An error status or an error in the body, unless the client cancelled.
    Error,
    Cancelled,
}

impl Outcome {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ok" => Some(Self::Ok),
            "error" => Some(Self::Error),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    fn condition(self) -> &'static str {
        match self {
            Self::Ok => "r.status < 400 and r.error is null and not r.cancelled",
            Self::Error => "(r.status >= 400 or r.error is not null) and not r.cancelled",
            Self::Cancelled => "r.cancelled",
        }
    }
}

/// Conditions on `requests r`, all ANDed; `None` fields do not filter.
#[derive(Debug, Default)]
pub struct RequestFilter {
    /// Only this user's rows; `None` is everyone.
    pub sub: Option<String>,
    pub before: Option<i64>,
    pub after: Option<i64>,
    /// A case-insensitive substring of model, backend, route, error, effort or key name, or
    /// the row id.
    pub q: Option<String>,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub route: Option<String>,
    pub key: Option<i64>,
    pub outcome: Option<Outcome>,
    /// `at >= from`.
    pub from: Option<DateTime<Utc>>,
    /// `at < to`.
    pub to: Option<DateTime<Utc>>,
}

impl RequestFilter {
    /// Appends ` where …`. The text search refers to `k`, the joined `api_keys`.
    fn push_where(&self, qb: &mut QueryBuilder<Postgres>) {
        qb.push(" where true");
        if let Some(sub) = &self.sub {
            qb.push(" and r.sub = ").push_bind(sub);
        }
        if let Some(before) = self.before {
            qb.push(" and r.id < ").push_bind(before);
        }
        if let Some(after) = self.after {
            qb.push(" and r.id > ").push_bind(after);
        }
        if let Some(q) = &self.q {
            let pattern = like_pattern(q);
            qb.push(" and (");
            for (i, column) in [
                "r.model",
                "r.backend",
                "r.route",
                "r.error",
                "r.effort",
                "k.name",
            ]
            .into_iter()
            .enumerate()
            {
                if i > 0 {
                    qb.push(" or ");
                }
                qb.push(column).push(" ilike ").push_bind(&pattern);
            }
            if let Ok(id) = q.parse::<i64>() {
                qb.push(" or r.id = ").push_bind(id);
            }
            qb.push(")");
        }
        for (column, value) in [
            ("r.model", &self.model),
            ("r.backend", &self.backend),
            ("r.route", &self.route),
        ] {
            if let Some(value) = value {
                qb.push(format!(" and {column} = ")).push_bind(value);
            }
        }
        if let Some(key) = self.key {
            qb.push(" and r.key_id = ").push_bind(key);
        }
        if let Some(outcome) = self.outcome {
            qb.push(format!(" and ({})", outcome.condition()));
        }
        if let Some(from) = self.from {
            qb.push(" and r.at >= ").push_bind(from);
        }
        if let Some(to) = self.to {
            qb.push(" and r.at < ").push_bind(to);
        }
    }
}

/// `%q%` for ILIKE, with the pattern characters in `q` matched literally.
fn like_pattern(q: &str) -> String {
    let mut pattern = String::with_capacity(q.len() + 2);
    pattern.push('%');
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// Matching rows, newest first.
pub async fn requests(
    db: &PgPool,
    filter: &RequestFilter,
    limit: i64,
) -> sqlx::Result<Vec<RequestRow>> {
    let mut qb = QueryBuilder::new(REQUEST_SELECT);
    filter.push_where(&mut qb);
    qb.push(" order by r.id desc limit ").push_bind(limit);
    qb.build_query_as().fetch_all(db).await
}

/// One row by id; `None` also when `sub` is given and the row is someone else's.
pub async fn request(db: &PgPool, id: i64, sub: Option<&str>) -> sqlx::Result<Option<RequestRow>> {
    let mut qb = QueryBuilder::new(REQUEST_SELECT);
    qb.push(" where r.id = ").push_bind(id);
    if let Some(sub) = sub {
        qb.push(" and r.sub = ").push_bind(sub);
    }
    qb.build_query_as().fetch_optional(db).await
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
pub struct Performance {
    pub model: Option<String>,
    pub backend: Option<String>,
    pub requests: i64,
    pub ttft_ms: Option<f64>,
    pub decode_tps: Option<f64>,
    pub tokens_per_round: Option<f64>,
}

/// Median TTFT, decode speed and tokens per round per model and backend, over successful
/// generations of the last `hours` hours: status below 400 and no error in the body.
pub async fn performance(db: &PgPool, hours: i32) -> sqlx::Result<Vec<Performance>> {
    sqlx::query_as(
        "select model, backend, count(*) as requests,
           percentile_cont(0.5) within group (order by ttft_ms) as ttft_ms,
           percentile_cont(0.5) within group (order by decode_tps) as decode_tps,
           percentile_cont(0.5) within group (order by tokens_per_round) as tokens_per_round
         from requests
         where at > now() - make_interval(hours => $1) and status < 400 and error is null
           and output_tokens > 0
         group by 1, 2 order by 1, 2",
    )
    .bind(hours)
    .fetch_all(db)
    .await
}

/// Counts, token sums and speed percentiles over a set of `requests r` rows. The percentiles
/// cover successful generations only, as in [`performance`].
const TOTALS: &str = "count(*) as requests,
   count(*) filter (where (r.status >= 400 or r.error is not null) and not r.cancelled) as errors,
   count(*) filter (where r.cancelled) as cancelled,
   coalesce(sum(r.prompt_tokens), 0)::bigint as prompt_tokens,
   coalesce(sum(r.cached_tokens), 0)::bigint as cached_tokens,
   coalesce(sum(r.output_tokens), 0)::bigint as output_tokens,
   percentile_cont(0.5) within group (order by r.ttft_ms) filter (where r.status < 400
     and r.error is null and r.output_tokens > 0) as ttft_p50,
   percentile_cont(0.95) within group (order by r.ttft_ms) filter (where r.status < 400
     and r.error is null and r.output_tokens > 0) as ttft_p95,
   percentile_cont(0.5) within group (order by r.decode_tps) filter (where r.status < 400
     and r.error is null and r.output_tokens > 0) as tps_p50,
   percentile_cont(0.95) within group (order by r.decode_tps) filter (where r.status < 400
     and r.error is null and r.output_tokens > 0) as tps_p95";

#[derive(Debug, Default, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub requests: i64,
    pub errors: i64,
    pub cancelled: i64,
    pub prompt_tokens: i64,
    pub cached_tokens: i64,
    pub output_tokens: i64,
    pub ttft_p50: Option<f64>,
    pub ttft_p95: Option<f64>,
    pub tps_p50: Option<f64>,
    pub tps_p95: Option<f64>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Point {
    /// The bucket's start.
    pub t: DateTime<Utc>,
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ModelTotals {
    pub model: Option<String>,
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Serialize, FromRow)]
pub struct BackendTotals {
    pub backend: Option<String>,
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct KeyTotals {
    pub key_id: i64,
    pub key_name: Option<String>,
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub totals: Totals,
}

#[derive(Debug, Serialize, FromRow)]
pub struct UserTotals {
    pub sub: String,
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub totals: Totals,
}

/// Everything the dashboard charts for one time window.
#[derive(Debug)]
pub struct Overview {
    pub totals: Totals,
    /// One point per bucket, empty buckets included.
    pub series: Vec<Point>,
    pub models: Vec<ModelTotals>,
    pub backends: Vec<BackendTotals>,
    pub keys: Vec<KeyTotals>,
    /// The 20 busiest users; filled only when `sub` is `None`.
    pub users: Vec<UserTotals>,
}

/// Totals for requests in `[from, to)`, only `sub`'s when given, with a series in buckets of
/// `bucket` seconds aligned to the Unix epoch, and breakdowns sorted by requests.
pub async fn overview(
    db: &PgPool,
    sub: Option<&str>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    bucket: i64,
) -> sqlx::Result<Overview> {
    let window = RequestFilter {
        sub: sub.map(str::to_owned),
        from: Some(from),
        to: Some(to),
        ..RequestFilter::default()
    };

    let mut qb = QueryBuilder::new(format!("select {TOTALS} from requests r"));
    window.push_where(&mut qb);
    let totals = qb.build_query_as().fetch_one(db).await?;

    let mut qb =
        QueryBuilder::new("with agg as (select to_timestamp(floor(extract(epoch from r.at) / ");
    qb.push_bind(bucket).push(") * ").push_bind(bucket);
    qb.push(format!(") as t, {TOTALS} from requests r"));
    window.push_where(&mut qb);
    qb.push(
        " group by 1)
         select b.t, coalesce(a.requests, 0) as requests, coalesce(a.errors, 0) as errors,
           coalesce(a.cancelled, 0) as cancelled, coalesce(a.prompt_tokens, 0) as prompt_tokens,
           coalesce(a.cached_tokens, 0) as cached_tokens,
           coalesce(a.output_tokens, 0) as output_tokens,
           a.ttft_p50, a.ttft_p95, a.tps_p50, a.tps_p95
         from generate_series(",
    );
    qb.push_bind(bucket_start(from, bucket))
        .push(", ")
        .push_bind(bucket_start(to, bucket))
        .push(", make_interval(secs => ")
        .push_bind(bucket as f64)
        .push(")) as b(t) left join agg a on a.t = b.t order by b.t");
    let series = qb.build_query_as().fetch_all(db).await?;

    let models = grouped(db, &window, "r.model", "", "r.model", None).await?;
    let backends = grouped(db, &window, "r.backend", "", "r.backend", None).await?;
    let keys = grouped(
        db,
        &window,
        "r.key_id, k.name as key_name",
        " left join api_keys k on k.id = r.key_id",
        "r.key_id, k.name",
        None,
    )
    .await?;
    let users = match sub {
        None => grouped(db, &window, "r.sub", "", "r.sub", Some(20)).await?,
        Some(_) => Vec::new(),
    };
    Ok(Overview {
        totals,
        series,
        models,
        backends,
        keys,
        users,
    })
}

/// [`TOTALS`] per `group`, busiest first.
async fn grouped<T>(
    db: &PgPool,
    window: &RequestFilter,
    columns: &str,
    join: &str,
    group: &str,
    limit: Option<i64>,
) -> sqlx::Result<Vec<T>>
where
    T: for<'r> FromRow<'r, PgRow> + Send + Unpin,
{
    let mut qb = QueryBuilder::new(format!("select {columns}, {TOTALS} from requests r{join}"));
    window.push_where(&mut qb);
    qb.push(format!(" group by {group} order by requests desc, 1"));
    if let Some(limit) = limit {
        qb.push(" limit ").push_bind(limit);
    }
    qb.build_query_as().fetch_all(db).await
}

/// The start of the `secs`-long, epoch-aligned bucket holding `t`.
fn bucket_start(t: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
    t - chrono::TimeDelta::seconds(t.timestamp().rem_euclid(secs))
        - chrono::TimeDelta::nanoseconds(i64::from(t.timestamp_subsec_nanos()))
}

pub async fn purge_bodies(db: &PgPool, days: i32) -> sqlx::Result<u64> {
    let done =
        sqlx::query("delete from request_bodies where at < now() - make_interval(days => $1)")
            .bind(days)
            .execute(db)
            .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use chrono::TimeDelta;

    use super::*;

    #[test]
    fn like_pattern_matches_wildcards_literally() {
        assert_eq!(like_pattern("gpt"), "%gpt%");
        assert_eq!(like_pattern(r"50%_a\b"), r"%50\%\_a\\b%");
    }

    #[test]
    fn bucket_start_aligns_to_the_epoch() {
        let t = DateTime::parse_from_rfc3339("2026-11-27T10:47:12.5Z")
            .unwrap()
            .to_utc();
        let want = DateTime::parse_from_rfc3339("2026-11-27T10:30:00Z")
            .unwrap()
            .to_utc();
        assert_eq!(bucket_start(t, 1_800), want);
        assert_eq!(bucket_start(want, 1_800), want);
    }

    #[test]
    fn stats_and_keys_serialize_in_camel_case() {
        let fields = |v: serde_json::Value| -> Vec<String> {
            v.as_object().unwrap().keys().cloned().collect()
        };
        let row = KeyTotals {
            key_id: 1,
            key_name: None,
            totals: Totals::default(),
        };
        let mut want = vec![
            "keyId",
            "keyName",
            "requests",
            "errors",
            "cancelled",
            "promptTokens",
            "cachedTokens",
            "outputTokens",
            "ttftP50",
            "ttftP95",
            "tpsP50",
            "tpsP95",
        ];
        want.sort_unstable();
        assert_eq!(fields(serde_json::to_value(&row).unwrap()), want);
        let key = Key {
            id: 1,
            name: String::new(),
            prefix: String::new(),
            created_at: Utc::now(),
            last_used_at: None,
            requests_30d: 0,
            prompt_tokens_30d: 0,
            cached_tokens_30d: 0,
            output_tokens_30d: 0,
        };
        let key = fields(serde_json::to_value(&key).unwrap());
        assert!(
            key.contains(&"requests30d".to_owned()) && key.contains(&"outputTokens30d".to_owned())
        );
    }

    /// Runs the portal's queries against a real database, which it migrates and adds rows to:
    /// `AI_TEST_DATABASE_URL=postgres://… cargo test -p herkules-ai -- --ignored`.
    #[tokio::test]
    #[ignore = "needs AI_TEST_DATABASE_URL"]
    async fn portal_queries() {
        let url = std::env::var("AI_TEST_DATABASE_URL").expect("AI_TEST_DATABASE_URL is set");
        let db = connect(&url, 2).await.unwrap();
        let run = Utc::now().timestamp_micros();
        let (a, b) = (format!("a-{run}"), format!("b-{run}"));
        let key = |sub: &str, name: &str| {
            let (sub, name) = (sub.to_owned(), name.to_owned());
            let db = db.clone();
            async move {
                create_key(&db, &sub, &name, &format!("{sub}-{name}"), "sk-hk-test")
                    .await
                    .unwrap()
                    .id
            }
        };
        let (laptop, server, other) = (
            key(&a, "laptop").await,
            key(&a, "server").await,
            key(&b, "x").await,
        );
        let now = Utc::now();
        let minutes = |m: i64| now - TimeDelta::minutes(m);
        // $1 and $2 are users a and b; $3, $4 and $5 are the keys laptop, server and other.
        let ids: Vec<i64> = sqlx::query_scalar(
            "insert into requests (at, sub, key_id, model, status, cancelled, error,
               output_tokens, ttft_ms, decode_tps, backend, method, route, duration_ms, streamed,
               prompt_tokens, level)
             select now() - make_interval(mins => m), s, k, model, status, c, e, o, ttft, tps,
               'gpu-a', 'POST', '/v1/chat/completions', 10, true, o, 'metadata'
             from (values
               (1, 10, $1, $3, 'm1', 200, false, null, 10, 100.0, 50.0),
               (2, 120, $1, $3, 'm1', 200, false, null, 20, 200.0, 30.0),
               (3, 180, $1, $4, 'm2', 500, false, 'upstream boom_x%', null, null, null),
               (4, 1500, $1, $4, 'm2', 200, false, 'in body', 5, 1.0, 1.0),
               (5, 5, $1, $3, 'm1', 499, true, null, null, null, null),
               (6, 57600, $1, $3, 'm1', 200, false, null, 7, 9.0, 9.0),
               (7, 30, $2, $5, 'm1', 200, false, null, 3, 50.0, 10.0)
             ) as v (n, m, s, k, model, status, c, e, o, ttft, tps)
             order by n returning id",
        )
        .bind(&a)
        .bind(&b)
        .bind(laptop)
        .bind(server)
        .bind(other)
        .fetch_all(&db)
        .await
        .unwrap();

        let count = |filter: RequestFilter| {
            let db = db.clone();
            async move { requests(&db, &filter, 200).await.unwrap().len() }
        };
        let mine = || RequestFilter {
            sub: Some(a.clone()),
            ..RequestFilter::default()
        };
        let text = |q: &str| RequestFilter {
            q: Some(q.to_owned()),
            ..mine()
        };
        assert_eq!(count(mine()).await, 6);
        for (outcome, want) in [
            (Outcome::Ok, 3),
            (Outcome::Error, 2),
            (Outcome::Cancelled, 1),
        ] {
            let filter = RequestFilter {
                outcome: Some(outcome),
                ..mine()
            };
            assert_eq!(count(filter).await, want, "{outcome:?}");
        }
        assert_eq!(count(text("BOOM_x%")).await, 1);
        assert_eq!(count(text("boom%x")).await, 0);
        assert_eq!(count(text("server")).await, 2);
        // A number also matches as a substring, here of `/v1/…`.
        let by_id = requests(&db, &text(&ids[0].to_string()), 200)
            .await
            .unwrap();
        assert!(by_id.iter().any(|r| r.id == ids[0]));
        assert_eq!(
            count(RequestFilter {
                model: Some("m2".into()),
                ..mine()
            })
            .await,
            2
        );
        assert_eq!(
            count(RequestFilter {
                key: Some(laptop),
                ..mine()
            })
            .await,
            4
        );
        assert_eq!(
            count(RequestFilter {
                after: Some(ids[3]),
                ..mine()
            })
            .await,
            2
        );
        assert_eq!(
            count(RequestFilter {
                before: Some(ids[1]),
                ..mine()
            })
            .await,
            1
        );
        let day = RequestFilter {
            from: Some(minutes(24 * 60)),
            to: Some(minutes(7)),
            ..mine()
        };
        assert_eq!(count(day).await, 3);

        assert!(request(&db, ids[0], Some(&b)).await.unwrap().is_none());
        let row = request(&db, ids[0], Some(&a)).await.unwrap().unwrap();
        assert_eq!(row.key_name.as_deref(), Some("laptop"));

        let day = overview(&db, Some(&a), minutes(24 * 60), now, 1_800)
            .await
            .unwrap();
        assert_eq!(day.series.len(), 49);
        assert_eq!(day.series.iter().map(|p| p.totals.requests).sum::<i64>(), 4);
        let t = &day.totals;
        assert_eq!(
            (t.requests, t.errors, t.cancelled, t.output_tokens),
            (4, 1, 1, 30)
        );
        assert_eq!((t.ttft_p50, t.tps_p50), (Some(150.0), Some(40.0)));
        assert_eq!(day.models[0].model.as_deref(), Some("m1"));
        assert_eq!(day.keys.len(), 2);
        assert!(day.users.is_empty());
        let hour = overview(&db, None, minutes(60), now, 60).await.unwrap();
        assert_eq!(hour.series.len(), 61);
        assert!(hour.users.iter().any(|u| u.sub == b) && hour.users.iter().any(|u| u.sub == a));

        let usage: Vec<(i64, i64)> = keys(&db, &a)
            .await
            .unwrap()
            .iter()
            .map(|k| (k.requests_30d, k.output_tokens_30d))
            .collect();
        assert_eq!(usage, [(3, 30), (2, 5)]);
    }
}
