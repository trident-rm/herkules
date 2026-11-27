//! The portal host: sign-in, keys, usage, the request log, performance and administration.
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
use herkules_auth::{Failure, Principal, with_cookies};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    App,
    backends::{Source, State as BackendState},
    cloudflare, config, db, keys, levels,
};

type AppState = State<Arc<App>>;

pub fn router(app: Arc<App>) -> Router {
    let api = Router::new()
        .route("/me", get(me))
        .route("/keys", get(list_keys).post(create_key))
        .route("/keys/{id}", delete(revoke_key))
        .route("/usage", get(usage))
        .route("/requests", get(requests))
        .route("/requests/{id}/body", get(body))
        .route("/performance", get(performance))
        .route("/admin/usage", get(admin_usage))
        .route("/admin/backends", post(add_backend))
        .route("/admin/backends/{name}", delete(remove_backend))
        .route("/admin/backends/{name}/state", put(set_state))
        .route("/admin/logging", get(logging).put(set_logging))
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

#[derive(Deserialize)]
struct Days {
    days: Option<i32>,
}

async fn usage(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Query(q): Query<Days>,
) -> Response {
    let days = q.days.unwrap_or(30).clamp(1, 366);
    match db::usage(&app.db, Some(&p.subject), days).await {
        Ok(rows) => Json(json!({"days": rows})).into_response(),
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

async fn admin_usage(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Query(q): Query<Days>,
) -> Response {
    let days = q.days.unwrap_or(30).clamp(1, 366);
    let rows = match db::usage(&app.db, None, days).await {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let mut subs: Vec<String> = rows.iter().map(|r| r.sub.clone()).collect();
    subs.sort_unstable();
    subs.dedup();
    let users = names(&app, &p, subs).await;
    Json(json!({"days": rows, "users": users})).into_response()
}

#[derive(Deserialize)]
struct Page {
    before: Option<i64>,
    limit: Option<i64>,
    /// Admins: one user's requests, or everyone's with `all`.
    sub: Option<String>,
    all: Option<bool>,
}

async fn requests(
    State(app): AppState,
    Extension(p): Extension<Principal>,
    Query(q): Query<Page>,
) -> Response {
    let sub = if is_admin(&p) && q.all == Some(true) {
        None
    } else if is_admin(&p) && q.sub.is_some() {
        q.sub.clone()
    } else {
        Some(p.subject.clone())
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    match db::requests(&app.db, sub.as_deref(), q.before, limit).await {
        Ok(rows) => Json(json!({"requests": rows})).into_response(),
        Err(e) => internal(e),
    }
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
    let busy = entry.inflight.load(std::sync::atomic::Ordering::Relaxed) as f64
        + entry.live().running
        + entry.live().waiting;
    if busy > 0.0 {
        if entry.state() != BackendState::Draining {
            if let Err(e) =
                db::set_backend_state(&app.db, &name, BackendState::Draining, &p.subject).await
            {
                return internal(e);
            }
            app.backends.set_state(&name, BackendState::Draining);
        }
        return problem(
            StatusCode::CONFLICT,
            "the backend is busy and now draining; remove it again once it is idle",
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
    tracing::info!(backend = %name, by = %p.subject, "tunnel backend removed");
    StatusCode::NO_CONTENT.into_response()
}

async fn logging(State(app): AppState, Extension(p): Extension<Principal>) -> Response {
    let overrides = app.levels.get();
    let subs: Vec<String> = overrides.users.keys().cloned().collect();
    let users = names(&app, &p, subs).await;
    Json(json!({"overrides": overrides, "users": users})).into_response()
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
