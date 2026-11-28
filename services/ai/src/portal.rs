//! The portal host: sign-in, keys, stats, the request log, performance and administration.
//!
//! Browser sessions are the shared first-party OAuth client from `herkules-auth`; a bearer
//! token for the `api/ai` audience works too. Admin routes require the token's `admin` role.

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use chrono::{DateTime, TimeDelta, Utc};
use herkules_auth::{Failure, Principal, with_cookies};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    App,
    backends::{BackendPolicy, Routing, Source, State as BackendState},
    cloudflare, config, db, keys, levels,
};

type AppState = State<Arc<App>>;

pub fn router(app: Arc<App>) -> Router {
    let api = Router::new()
        .route("/me", get(me))
        .route("/keys", get(list_keys).post(create_key))
        .route("/keys/{id}", delete(revoke_key))
        .route("/requests", get(requests))
        .route("/requests/{id}", get(request))
        .route("/requests/{id}/body", get(body))
        .route("/stats", get(stats))
        .route("/backends/live", get(live_backends))
        .route("/performance", get(performance))
        .route("/admin/backends", post(add_backend))
        .route("/admin/backends/{name}", delete(remove_backend))
        .route("/admin/routing", get(routing).put(set_routing))
        .route("/admin/backends/{name}/routing", put(set_backend_policy))
        .route("/admin/backends/{name}/state", put(set_state))
        .route("/admin/logging", get(logging).put(set_logging))
        .route("/admin/logging/retention", put(set_body_retention))
        .route("/admin/logging/storage", get(log_storage))
        .layer(middleware::from_fn_with_state(Arc::clone(&app), session));
    let mut router = Router::new()
        .nest("/api", api)
        .route("/login", get(login))
        .route("/callback", get(callback))
        .route("/logout", post(logout));
    if let Some(dir) = &app.config.web_dir {
        let index = dir.join("index.html");
        router = router.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .fallback(tower_http::services::ServeFile::new(index)),
        );
    }
    router.with_state(app)
}

fn problem(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": status.canonical_reason().unwrap_or("error"), "error_description": message})),
    )
        .into_response()
}

fn internal(e: impl std::fmt::Display) -> Response {
    tracing::error!("portal: {e}");
    problem(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

async fn session(State(app): AppState, mut request: Request, next: Next) -> Response {
    let outcome = app.auth.resolve(request.headers(), request.method()).await;
    let principal = match (outcome.principal, outcome.failure) {
        (Some(p), _) => p,
        (None, failure) => {
            return with_cookies(
                failure
                    .unwrap_or(Failure::Missing)
                    .response(&app.auth.api_resource, false),
                outcome.cookies,
            );
        }
    };
    if request.uri().path().starts_with("/admin/") && principal.role != "admin" {
        return with_cookies(
            problem(StatusCode::FORBIDDEN, "administrators only"),
            outcome.cookies,
        );
    }
    request.extensions_mut().insert(principal);
    let mut response = with_cookies(next.run(request).await, outcome.cookies);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

async fn login(
    State(app): AppState,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    app.auth.login(&headers, &q)
}

async fn callback(
    State(app): AppState,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    app.auth.callback(&headers, &q).await
}

async fn logout(State(app): AppState, headers: HeaderMap) -> Response {
    app.auth.logout(&headers, Some("/")).await
}

fn is_admin(p: &Principal) -> bool {
    p.role == "admin"
}

async fn me(State(app): AppState, Extension(p): Extension<Principal>) -> Response {
    let profile = app.auth.user_profile(&p).await;
    let overrides = app.levels.get();
    let models: Vec<String> = app.backends.available_models().into_iter().collect();
    let logging: BTreeMap<&str, &str> = models
        .iter()
        .map(|m| (m.as_str(), overrides.level(&p.subject, Some(m))))
        .collect();
    Json(json!({
        "sub": p.subject,
        "role": p.role,
        "displayName": profile.as_ref().map_or(json!(p.subject), |v| v["displayName"].clone()),
        "avatarUrl": profile.as_ref().map_or(Value::Null, |v| v["avatarUrl"].clone()),
        "apiOrigin": app.config.api_origin,
        "models": models,
        "logging": {
            "user": overrides.users.get(&p.subject),
            "models": logging,
            "default": levels::METADATA,
        },
    }))
    .into_response()
}

async fn list_keys(State(app): AppState, Extension(p): Extension<Principal>) -> Response {
    match db::keys(&app.db, &p.subject).await {
        Ok(keys) => Json(json!({"keys": keys})).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
struct NewKey {
    name: String,
}

async fn create_key(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Json(body): Json<NewKey>,
) -> Response {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return problem(
            StatusCode::BAD_REQUEST,
            "name must be 1-80 printable characters",
        );
    }
    let key = keys::generate();
    match db::create_key(&app.db, &p.subject, name, &key.hash, &key.prefix).await {
        Ok(row) => (
            StatusCode::CREATED,
            Json(json!({"key": row, "secret": key.secret})),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

async fn revoke_key(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> Response {
    match db::revoke_key(&app.db, &p.subject, id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => problem(StatusCode::NOT_FOUND, "no such key"),
        Err(e) => internal(e),
    }
}

/// Display names for `subs` from the auth service, with the admin's own token.
async fn names(app: &App, p: &Principal, subs: Vec<String>) -> HashMap<String, Value> {
    let mut names = HashMap::new();
    for chunk in subs.chunks(100) {
        let answer = app
            .http
            .post(format!(
                "{}/auth/api/users/batch",
                app.config.auth.internal_origin
            ))
            .bearer_auth(&p.token)
            .json(&json!({"ids": chunk}))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        let Ok(answer) = answer else { continue };
        let Ok(body) = answer.json::<Value>().await else {
            continue;
        };
        for user in body["users"].as_array().into_iter().flatten() {
            if let Some(id) = user["id"].as_str() {
                names.insert(
                    id.to_owned(),
                    json!({"displayName": user["displayName"], "avatarUrl": user["avatarUrl"]}),
                );
            }
        }
    }
    names
}

/// Whose rows a read covers; `None` is everyone. Members always get their own. Admins get
/// their own unless they ask for everyone's with `all` or one user's with `sub`.
fn scope(p: &Principal, all: Option<bool>, sub: Option<String>) -> Option<String> {
    if !is_admin(p) {
        Some(p.subject.clone())
    } else if all == Some(true) {
        None
    } else {
        Some(sub.unwrap_or_else(|| p.subject.clone()))
    }
}

/// A query parameter, with an empty value treated as absent.
fn given(raw: Option<String>) -> Option<String> {
    raw.filter(|s| !s.is_empty())
}

fn instant(raw: Option<&str>) -> Result<Option<DateTime<Utc>>, chrono::ParseError> {
    raw.map(|s| DateTime::parse_from_rfc3339(s).map(|t| t.to_utc()))
        .transpose()
}

#[derive(Deserialize)]
struct Page {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<i64>,
    /// Admins: one user's requests, or everyone's with `all`.
    sub: Option<String>,
    all: Option<bool>,
    q: Option<String>,
    model: Option<String>,
    backend: Option<String>,
    route: Option<String>,
    key: Option<i64>,
    status: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

async fn requests(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Query(q): Query<Page>,
) -> Response {
    let outcome = match given(q.status).map(|s| db::Outcome::parse(&s)) {
        None => None,
        Some(Some(outcome)) => Some(outcome),
        Some(None) => {
            return problem(StatusCode::BAD_REQUEST, "status is ok, error or cancelled");
        }
    };
    let (Ok(from), Ok(to)) = (
        instant(given(q.from).as_deref()),
        instant(given(q.to).as_deref()),
    ) else {
        return problem(
            StatusCode::BAD_REQUEST,
            "from and to are RFC 3339 timestamps",
        );
    };
    let sub = scope(&p, q.all, q.sub);
    let others = sub.as_deref() != Some(p.subject.as_str());
    let filter = db::RequestFilter {
        sub,
        before: q.before,
        after: q.after,
        q: given(q.q.map(|s| s.trim().to_owned())),
        model: given(q.model),
        backend: given(q.backend),
        route: given(q.route),
        key: q.key,
        outcome,
        from,
        to,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = match db::requests(&app.db, &filter, limit).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let users = if others && !rows.is_empty() {
        let mut subs: Vec<String> = rows.iter().map(|r| r.sub.clone()).collect();
        subs.sort_unstable();
        subs.dedup();
        names(&app, &p, subs).await
    } else {
        HashMap::new()
    };
    Json(json!({"requests": rows, "users": users})).into_response()
}

async fn request(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> Response {
    let sub = (!is_admin(&p)).then_some(p.subject.as_str());
    match db::request(&app.db, id, sub).await {
        Ok(Some(row)) => Json(json!({"request": row})).into_response(),
        Ok(None) => problem(StatusCode::NOT_FOUND, "no such request"),
        Err(e) => internal(e),
    }
}

/// A stats range's length and bucket size, in seconds.
fn stats_range(name: &str) -> Option<(i64, i64)> {
    match name {
        "1h" => Some((3_600, 60)),
        "24h" => Some((86_400, 1_800)),
        "7d" => Some((7 * 86_400, 10_800)),
        "30d" => Some((30 * 86_400, 43_200)),
        _ => None,
    }
}

#[derive(Deserialize)]
struct StatsQuery {
    range: Option<String>,
    from: Option<String>,
    to: Option<String>,
    sub: Option<String>,
    all: Option<bool>,
}

fn custom_stats_bucket(length_seconds: i64) -> i64 {
    let target = (length_seconds + 95) / 96;
    [60, 300, 900, 1_800, 3_600, 10_800, 21_600, 43_200, 86_400]
        .into_iter()
        .find(|bucket| *bucket >= target)
        .unwrap_or_else(|| ((target + 86_399) / 86_400) * 86_400)
}

async fn stats(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Query(q): Query<StatsQuery>,
) -> Response {
    let (range, from, to, bucket) = if q.from.is_some() || q.to.is_some() {
        match (instant(q.from.as_deref()), instant(q.to.as_deref())) {
            (Ok(Some(from)), Ok(Some(to))) if from < to && q.range.is_none() => (
                "custom".to_owned(),
                from,
                to,
                custom_stats_bucket((to - from).num_seconds()),
            ),
            _ => {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "use RFC 3339 from and to with from before to, or use a preset range",
                );
            }
        }
    } else {
        let range = given(q.range).unwrap_or_else(|| "24h".to_owned());
        let Some((length, bucket)) = stats_range(&range) else {
            return problem(StatusCode::BAD_REQUEST, "range is 1h, 24h, 7d or 30d");
        };
        let to = Utc::now();
        (range, to - TimeDelta::seconds(length), to, bucket)
    };
    let sub = scope(&p, q.all, q.sub);
    let overview = match db::overview(&app.db, sub.as_deref(), from, to, bucket).await {
        Ok(overview) => overview,
        Err(e) => return internal(e),
    };
    let errors = db::RequestFilter {
        sub,
        outcome: Some(db::Outcome::Error),
        from: Some(from),
        to: Some(to),
        ..db::RequestFilter::default()
    };
    let recent_errors = match db::requests(&app.db, &errors, 10).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let names = if overview.users.is_empty() {
        HashMap::new()
    } else {
        let subs = overview.users.iter().map(|u| u.sub.clone()).collect();
        names(&app, &p, subs).await
    };
    let users: Vec<Value> = overview
        .users
        .iter()
        .map(|u| {
            let name = names.get(&u.sub);
            let mut view = json!(u);
            view["displayName"] = name.map_or(Value::Null, |n| n["displayName"].clone());
            view["avatarUrl"] = name.map_or(Value::Null, |n| n["avatarUrl"].clone());
            view
        })
        .collect();
    Json(json!({
        "range": range,
        "bucketSeconds": bucket,
        "from": from,
        "to": to,
        "totals": overview.totals,
        "series": overview.series,
        "models": overview.models,
        "backends": overview.backends,
        "decodeByLoad": overview.decode_by_load,
        "keys": overview.keys,
        "users": users,
        "recentErrors": recent_errors,
    }))
    .into_response()
}

async fn body(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(id): Path<i64>,
) -> Response {
    let row = match db::bodies(&app.db, id).await {
        Ok(Some(row)) if row.sub == p.subject || is_admin(&p) => row,
        Ok(_) => return problem(StatusCode::NOT_FOUND, "no stored body for this request"),
        Err(e) => return internal(e),
    };
    let text = |bytes: &[u8]| {
        zstd::decode_all(bytes)
            .map(|raw| String::from_utf8_lossy(&raw).into_owned())
            .unwrap_or_default()
    };
    Json(json!({
        "request": text(&row.request),
        "requestBytes": row.request_bytes,
        "requestTruncated": row.request_truncated,
        "response": text(&row.response),
        "responseBytes": row.response_bytes,
        "responseTruncated": row.response_truncated,
    }))
    .into_response()
}

fn backend_view(app: &App, admin: bool) -> Vec<Value> {
    app.backends
        .all()
        .iter()
        .map(|e| {
            let mut view = json!({
                "name": e.backend.name,
                "models": e.backend.models,
                "state": e.state(),
                "live": e.live(),
                "inflight": e.inflight.load(std::sync::atomic::Ordering::Relaxed),
            });
            if admin {
                view["source"] = json!(e.backend.source);
            }
            view
        })
        .collect()
}

async fn live_backends(State(app): AppState, Extension(p): Extension<Principal>) -> Json<Value> {
    Json(json!({
        "backends": backend_view(&app, is_admin(&p)),
        "tunnels": app.cloudflare.is_some(),
    }))
}

async fn performance(State(app): AppState, Extension(p): Extension<Principal>) -> Response {
    match db::performance(&app.db, 24).await {
        Ok(rows) => Json(json!({
            "medians": rows,
            "backends": backend_view(&app, is_admin(&p)),
            "tunnels": app.cloudflare.is_some(),
        }))
        .into_response(),
        Err(e) => internal(e),
    }
}

async fn routing(State(app): AppState) -> Json<Value> {
    Json(json!({
        "settings": app.backends.routing(),
        "backends": app.backends.policies(),
    }))
}

async fn set_routing(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Json(routing): Json<Routing>,
) -> Response {
    if routing.wait_seconds > 60 {
        return problem(
            StatusCode::BAD_REQUEST,
            "wait time must be between 0 and 60 seconds",
        );
    }
    let _admin = app.backend_admin.lock().await;
    if let Err(e) = db::save_routing(&app.db, routing).await {
        return internal(e);
    }
    app.backends.set_routing(routing);
    tracing::info!(?routing, by = %p.subject, "backend routing settings updated");
    StatusCode::NO_CONTENT.into_response()
}

async fn set_backend_policy(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(name): Path<String>,
    Json(policy): Json<BackendPolicy>,
) -> Response {
    if policy.max_streams == Some(0) {
        return problem(StatusCode::BAD_REQUEST, "max streams must be positive");
    }
    let _admin = app.backend_admin.lock().await;
    if app.backends.get(&name).is_none() {
        return problem(StatusCode::NOT_FOUND, "no such backend");
    }
    if let Err(e) = db::save_backend_policy(&app.db, &name, policy).await {
        return internal(e);
    }
    tracing::info!(backend = %name, ?policy, by = %p.subject, "backend routing policy updated");
    app.backends.set_policy(name, policy);
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct StateBody {
    state: BackendState,
}

async fn set_state(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(name): Path<String>,
    Json(body): Json<StateBody>,
) -> Response {
    let _admin = app.backend_admin.lock().await;
    if app.backends.get(&name).is_none() {
        return problem(StatusCode::NOT_FOUND, "no such backend");
    }
    if let Err(e) = db::set_backend_state(&app.db, &name, body.state, &p.subject).await {
        return internal(e);
    }
    app.backends.set_state(&name, body.state);
    tracing::info!(backend = %name, state = body.state.as_str(), by = %p.subject, "backend state");
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct AddBackend {
    name: String,
    models: Vec<String>,
    port: u16,
}

async fn add_backend(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Json(body): Json<AddBackend>,
) -> Response {
    let _admin = app.backend_admin.lock().await;
    let Some(cf) = app.cloudflare.as_ref() else {
        return problem(
            StatusCode::CONFLICT,
            "tunnel backends need AI_CLOUDFLARE_FILE; add file backends to AI_BACKENDS_FILE",
        );
    };
    let models: Vec<String> = body
        .models
        .iter()
        .map(|m| m.trim().to_owned())
        .filter(|m| !m.is_empty())
        .collect();
    if !config::valid_name(&body.name)
        || models.is_empty()
        || models
            .iter()
            .any(|m| m.len() > 200 || m.chars().any(char::is_control))
        || body.port == 0
    {
        return problem(
            StatusCode::BAD_REQUEST,
            "name (letters, digits, - and _), at least one model and a port are required",
        );
    }
    if app.backends.get(&body.name).is_some() {
        return problem(StatusCode::CONFLICT, "a backend with that name exists");
    }
    let made = match cf.provision(body.port).await {
        Ok(made) => made,
        Err(e) => {
            tracing::error!("provision {}: {e}", body.name);
            return problem(StatusCode::BAD_GATEWAY, &format!("Cloudflare: {e}"));
        }
    };
    let row = db::TunnelBackend {
        name: body.name.clone(),
        hostname: made.hostname.clone(),
        port: i32::from(body.port),
        models,
        tunnel_id: made.tunnel_id.clone(),
        dns_record_id: made.dns_record_id.clone(),
    };
    if let Err(e) = db::insert_tunnel_backend(&app.db, &row, &p.subject).await {
        // Keep Cloudflare and the database in step.
        let _ = cf.delete_record(&made.dns_record_id).await;
        let _ = cf.delete_tunnel(&made.tunnel_id).await;
        return internal(e);
    }
    if let Err(e) = crate::reload_backends(&app).await {
        return internal(e);
    }
    tracing::info!(backend = %body.name, hostname = %made.hostname, by = %p.subject, "tunnel backend added");
    (
        StatusCode::CREATED,
        Json(json!({
            "name": body.name,
            "hostname": made.hostname,
            "install": cloudflare::install_command(&made.token),
        })),
    )
        .into_response()
}

async fn remove_backend(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Path(name): Path<String>,
) -> Response {
    let _admin = app.backend_admin.lock().await;
    let Some(entry) = app.backends.get(&name) else {
        return problem(StatusCode::NOT_FOUND, "no such backend");
    };
    let Source::Tunnel {
        tunnel_id,
        dns_record_id,
        ..
    } = entry.backend.source.clone()
    else {
        return problem(
            StatusCode::CONFLICT,
            "this backend comes from AI_BACKENDS_FILE; remove it there",
        );
    };
    let Some(cf) = app.cloudflare.as_ref() else {
        return problem(StatusCode::CONFLICT, "AI_CLOUDFLARE_FILE is not configured");
    };
    // Stop new admissions before checking whether it is safe to remove the tunnel.
    if entry.state() == BackendState::Enabled {
        if let Err(e) =
            db::set_backend_state(&app.db, &name, BackendState::Draining, &p.subject).await
        {
            return internal(e);
        }
        app.backends.set_state(&name, BackendState::Draining);
    }
    let live = entry.live();
    let busy = entry.inflight.load(std::sync::atomic::Ordering::Relaxed) as f64
        + live.running
        + live.waiting;
    if busy > 0.0 {
        return problem(
            StatusCode::CONFLICT,
            "the backend is busy; remove it again once it is idle",
        );
    }
    if let Err(e) = cf.delete_record(&dns_record_id).await {
        return problem(StatusCode::BAD_GATEWAY, &format!("Cloudflare: {e}"));
    }
    if let Err(e) = cf.delete_tunnel(&tunnel_id).await {
        // The record is gone, so no traffic reaches the tunnel; report and keep the row so
        // the admin can retry once the connector is stopped.
        return problem(
            StatusCode::BAD_GATEWAY,
            &format!(
                "DNS record deleted; tunnel not deleted: {e}. Stop cloudflared on the machine and remove again."
            ),
        );
    }
    if let Err(e) = db::delete_tunnel_backend(&app.db, &name).await {
        return internal(e);
    }
    if let Err(e) = crate::reload_backends(&app).await {
        return internal(e);
    }
    app.backends.delete_policy(&name);
    tracing::info!(backend = %name, by = %p.subject, "tunnel backend removed");
    StatusCode::NO_CONTENT.into_response()
}

async fn logging(State(app): AppState, Extension(p): Extension<Principal>) -> Response {
    let retention: BTreeMap<_, _> = match db::body_retention(&app.db).await {
        Ok(rows) => rows.into_iter().collect(),
        Err(e) => return internal(e),
    };
    let overrides = app.levels.get();
    let subs: Vec<String> = overrides.users.keys().cloned().collect();
    let users = names(&app, &p, subs).await;
    let models: std::collections::BTreeSet<String> = app
        .backends
        .all()
        .iter()
        .flat_map(|entry| entry.backend.models.iter().cloned())
        .chain(overrides.models.keys().cloned())
        .chain(retention.keys().cloned())
        .collect();
    Json(json!({
        "overrides": overrides,
        "users": users,
        "models": models,
        "retention": retention,
        "defaultRetentionDays": app.config.log_retention_days,
        "bodyLimitBytes": app.config.log_body_bytes,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct RetentionBody {
    model: String,
    #[serde(flatten)]
    retention: db::BodyRetention,
}

async fn set_body_retention(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Json(body): Json<RetentionBody>,
) -> Response {
    let model = body.model.trim();
    if model.is_empty() {
        return problem(StatusCode::BAD_REQUEST, "a model id is required");
    }
    if let db::BodyRetention::Days { days } = body.retention
        && !(1..=36_500).contains(&days)
    {
        return problem(
            StatusCode::BAD_REQUEST,
            "retention must be 1 to 36,500 days",
        );
    }
    if let Err(e) = db::set_body_retention(&app.db, model, body.retention, &p.subject).await {
        return internal(e);
    }
    tracing::info!(model, retention = ?body.retention, by = %p.subject, "body retention policy");
    StatusCode::NO_CONTENT.into_response()
}

async fn log_storage(State(app): AppState) -> Response {
    let storage = match db::log_storage(&app.db).await {
        Ok(storage) => storage,
        Err(e) => return internal(e),
    };
    let next_cleanup = *app.next_body_cleanup.read().unwrap();
    Json(json!({"storage": storage, "nextCleanup": next_cleanup})).into_response()
}

#[derive(Deserialize)]
struct LevelBody {
    scope: String,
    subject: String,
    level: Option<String>,
}

async fn set_logging(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Json(body): Json<LevelBody>,
) -> Response {
    let level = match body.level.as_deref() {
        None => None,
        Some(raw) => match levels::parse(raw) {
            Some(level) => Some(level),
            None => return problem(StatusCode::BAD_REQUEST, "level is metadata or full"),
        },
    };
    let subject = body.subject.trim();
    if !matches!(body.scope.as_str(), "user" | "model") || subject.is_empty() {
        return problem(
            StatusCode::BAD_REQUEST,
            "scope is user or model, with a subject",
        );
    }
    if let Err(e) = db::set_log_level(&app.db, &body.scope, subject, level, &p.subject).await {
        return internal(e);
    }
    match db::log_levels(&app.db).await {
        Ok(rows) => app.levels.load(rows),
        Err(e) => return internal(e),
    }
    tracing::info!(scope = %body.scope, subject, level = ?level, by = %p.subject, "logging level");
    StatusCode::NO_CONTENT.into_response()
}
