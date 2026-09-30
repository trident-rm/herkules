use axum::{
    Json, Router,
    extract::Request,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::HeaderMap,
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

use crate::{
    feed::{FeedError, FeedQuery},
    kb::{EntityQuery, KbQuery, entity_key},
    library::{ContentFormat, Library, article_id},
    reader,
    search::SearchError,
};

#[derive(Clone)]
pub struct AppState {
    pub library: Library,
    pub app_origin: String,
    pub stylesheet: Option<String>,
    pub auth: Option<Arc<crate::session::Auth>>,
    pub refresh_pool: Option<sqlx::PgPool>,
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/healthz", get(health))
        .route("/api/viewer", get(viewer))
        .route("/api/me", get(me))
        .route("/login", get(login))
        .route("/callback", get(callback))
        .route("/logout", post(logout))
        .route("/api/articles", get(feed))
        .route("/api/search", get(search))
        .route("/api/kb/browse", get(kb_browse))
        .route("/api/kb/entities", get(entities))
        .route("/api/kb/entities/{name}", get(entity))
        .route("/api/kb/entities/{name}/head", get(entity_head))
        .route("/api/status", get(status))
        .route("/api/articles/{id}/head", get(head))
        .route("/api/articles/{id}", get(article))
        .route("/api/articles/{id}/content", get(content))
        .route("/api/articles/{id}/ai", get(ai))
        .route("/api/tags", get(tags))
        .route("/articles/{id}", get(article_page))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found", "no such route") })
        .layer(middleware::from_fn_with_state(state.clone(), api_auth));
    if let Some(auth) = &state.auth {
        use rmcp::transport::streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
        };
        let library = state.library.clone();
        let service = StreamableHttpService::new(
            move || {
                Ok(crate::mcp::Mcp {
                    library: library.clone(),
                })
            },
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true)
                .with_allowed_origins([
                    state.app_origin.clone(),
                    auth.api_resource
                        .strip_suffix("/api/bbs")
                        .unwrap()
                        .to_owned(),
                ]),
        );
        app = app
            .route(
                "/mcp/bbs/healthz",
                get(|| async { Json(json!({"ok":true})) }),
            )
            .route_service("/mcp/bbs", service)
            .layer(middleware::from_fn_with_state(state.clone(), mcp_auth));
    }
    app.with_state(state)
}
async fn mcp_auth(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if request.uri().path() != "/mcp/bbs" {
        return next.run(request).await;
    }
    let auth = state.auth.as_ref().expect("MCP only mounted with auth");
    match auth
        .verifier
        .header(request.headers(), &auth.mcp_resource)
        .await
    {
        Ok(principal) => {
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Err(failure) => failure.response(&auth.mcp_resource, true),
    }
}
async fn api_auth(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    let Some(auth) = &state.auth else {
        if request.headers().contains_key(header::AUTHORIZATION) {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "native authentication is not configured",
            );
        }
        return next.run(request).await;
    };
    let outcome = auth.resolve(request.headers(), request.method()).await;
    if outcome.explicit
        && let Some(f) = outcome.failure
    {
        return crate::session::with_cookies(
            f.response(&auth.api_resource, false),
            outcome.cookies,
        );
    }
    if let Some(p) = outcome.principal {
        request.extensions_mut().insert(p);
    } else if request.uri().path() == "/api/me" {
        return crate::session::with_cookies(
            outcome
                .failure
                .unwrap_or(crate::auth::Failure::Missing)
                .response(&auth.api_resource, false),
            outcome.cookies,
        );
    }
    let mut response = crate::session::with_cookies(next.run(request).await, outcome.cookies);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn viewer(
    State(state): State<AppState>,
    p: Option<axum::Extension<crate::auth::Principal>>,
) -> Response {
    let v = match (&state.auth, p) {
        (Some(auth), Some(p)) => crate::session::viewer(auth, &p).await,
        _ => serde_json::Value::Null,
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"viewer":v})),
    )
        .into_response()
}
async fn me(
    State(state): State<AppState>,
    p: Option<axum::Extension<crate::auth::Principal>>,
) -> Response {
    match (&state.auth, p) {
        (Some(auth), Some(p)) => Json(crate::session::viewer(auth, &p).await).into_response(),
        _ => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "native authentication is not configured",
        ),
    }
}
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    match state.auth {
        Some(auth) => auth.login(&headers, &q),
        None => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "native authentication is not configured",
        ),
    }
}
async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    match state.auth {
        Some(auth) => auth.callback(&headers, &q).await,
        None => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "native authentication is not configured",
        ),
    }
}
async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    body: String,
) -> Response {
    let next = if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| {
            s.to_ascii_lowercase()
                .starts_with("application/x-www-form-urlencoded")
        }) {
        url::form_urlencoded::parse(body.as_bytes())
            .find(|(k, _)| k == "next")
            .map(|(_, v)| v.into_owned())
    } else {
        None
    }
    .or_else(|| q.get("next").cloned());
    match state.auth {
        Some(auth) => auth.logout(&headers, next.as_deref()).await,
        None => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "native authentication is not configured",
        ),
    }
}

pub enum ApiError {
    Invalid,
    Feed(FeedError),
    Search(SearchError),
    Missing,
    Database(sqlx::Error),
    Render(askama::Error),
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e)
    }
}
impl From<askama::Error> for ApiError {
    fn from(e: askama::Error) -> Self {
        Self::Render(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "invalid article id or content format",
            ),
            Self::Feed(FeedError::InvalidQuery) => error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "invalid feed query",
            ),
            Self::Feed(FeedError::InvalidCursor) => {
                error(StatusCode::BAD_REQUEST, "invalid_cursor", "unusable cursor")
            }
            Self::Search(SearchError::Query(e)) => Self::Feed(e).into_response(),
            Self::Search(SearchError::Empty) => error(
                StatusCode::BAD_REQUEST,
                "empty_query",
                "search needs at least one term",
            ),
            Self::Missing => error(StatusCode::NOT_FOUND, "not_found", "no such row"),
            Self::Database(e) => {
                tracing::error!(error = %e, "corpus query failed");
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal error",
                )
            }
            Self::Render(e) => {
                tracing::error!(error = %e, "reader render failed");
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal error",
                )
            }
        }
    }
}
fn error(status: StatusCode, code: &str, description: &str) -> Response {
    (
        status,
        Json(json!({ "error": code, "error_description": description })),
    )
        .into_response()
}
fn id(path: Result<Path<String>, PathRejection>) -> Result<String, ApiError> {
    article_id(&path.map_err(|_| ApiError::Invalid)?.0).ok_or(ApiError::Invalid)
}

async fn health(State(state): State<AppState>) -> Response {
    let ok = state.library.healthy().await;
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "ok": ok })),
    )
        .into_response()
}

async fn feed(
    State(state): State<AppState>,
    query: Result<Query<FeedQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let query = query
        .map_err(|_| ApiError::Feed(FeedError::InvalidQuery))?
        .0
        .validate()
        .map_err(ApiError::Feed)?;
    Ok(Json(state.library.feed(query).await?).into_response())
}

async fn search(
    State(state): State<AppState>,
    query: Result<Query<FeedQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let query = query
        .map_err(|_| ApiError::Invalid)?
        .0
        .validate_search()
        .map_err(ApiError::Search)?;
    Ok(Json(state.library.search(query).await?).into_response())
}

async fn kb_browse(
    State(state): State<AppState>,
    query: Result<Query<KbQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let q = query
        .map_err(|_| ApiError::Invalid)?
        .0
        .validate()
        .map_err(ApiError::Feed)?;
    Ok(Json(state.library.kb_browse(q).await?).into_response())
}
async fn entities(
    State(state): State<AppState>,
    query: Result<Query<EntityQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let (q, limit) = query
        .map_err(|_| ApiError::Invalid)?
        .0
        .validate()
        .map_err(ApiError::Feed)?;
    Ok(Json(state.library.entities(q, limit).await?).into_response())
}
#[derive(Default, Deserialize)]
struct EntityKeyQuery {
    key: Option<String>,
}
fn entity_request_key(
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<EntityKeyQuery>, QueryRejection>,
    allow_key: bool,
) -> Result<String, ApiError> {
    let name = path.map_err(|_| ApiError::Invalid)?.0;
    let q = query.map_err(|_| ApiError::Invalid)?.0;
    if allow_key && let Some(key) = q.key {
        if key.encode_utf16().count() > 400 {
            return Err(ApiError::Invalid);
        }
        return Ok(key);
    }
    if name.is_empty() || name.encode_utf16().count() > 200 {
        return Err(ApiError::Invalid);
    }
    Ok(entity_key(&name))
}
async fn entity(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<EntityKeyQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let key = entity_request_key(path, query, state.auth.is_none())?;
    Ok(Json(state.library.entity(&key).await?.ok_or(ApiError::Missing)?).into_response())
}

async fn status(State(state): State<AppState>) -> Result<Response, ApiError> {
    Ok(Json(state.library.status().await?).into_response())
}
async fn head(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    Ok(Json(
        state
            .library
            .head(&id(path)?)
            .await?
            .ok_or(ApiError::Missing)?,
    )
    .into_response())
}
async fn entity_head(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<EntityKeyQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let key = entity_request_key(path, query, state.auth.is_none())?;
    Ok(Json(
        state
            .library
            .entity_head(&key)
            .await?
            .ok_or(ApiError::Missing)?,
    )
    .into_response())
}

async fn article(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    let article = state
        .library
        .article(&id(path)?)
        .await?
        .ok_or(ApiError::Missing)?;
    if let Some(pool) = &state.refresh_pool
        && let Err(e)=sqlx::query("UPDATE articles SET refresh_requested_at = now(), updated_at = now() WHERE id = $1 AND status = 'fetched' AND refresh_requested_at IS NULL AND coalesce(fetched_at, '-infinity'::timestamptz) < now() - interval '24 hours'").bind(&article.id).execute(pool).await {
            tracing::warn!(error=%e,"article refresh request failed");
    }
    Ok(Json(article).into_response())
}

#[derive(Default, Deserialize)]
struct ContentQuery {
    #[serde(default)]
    format: ContentFormat,
}

async fn content(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<ContentQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let id = id(path)?;
    let format = query.map_err(|_| ApiError::Invalid)?.format;
    let content = state
        .library
        .content(&id, format)
        .await?
        .ok_or(ApiError::Missing)?;
    Ok((
        [
            (header::CONTENT_TYPE, content.format.content_type()),
            (
                header::HeaderName::from_static("x-content-format"),
                content.format.as_str(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        content.body,
    )
        .into_response())
}

async fn ai(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    Ok(Json(
        state
            .library
            .ai(&id(path)?)
            .await?
            .ok_or(ApiError::Missing)?,
    )
    .into_response())
}

async fn tags(State(state): State<AppState>) -> Result<Response, ApiError> {
    Ok(Json(state.library.tags().await?).into_response())
}

async fn article_page(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
) -> Response {
    let result = async {
        let article = state
            .library
            .article(&id(path)?)
            .await?
            .ok_or(ApiError::Missing)?;
        // An unavailable AI panel must not prevent reading the article.
        let ai = match state.library.ai(&article.id).await {
            Ok(ai) => ai,
            Err(error) => {
                tracing::warn!(error = %error, "reader AI panel unavailable");
                None
            }
        };
        Ok::<_, ApiError>(reader::render(
            &article,
            ai.as_ref(),
            &state.app_origin,
            state.stylesheet.as_deref(),
        )?)
    }
    .await;
    let (status, html) = match result {
        Ok(html) => (StatusCode::OK, html),
        Err(ApiError::Invalid | ApiError::Missing) => (
            StatusCode::NOT_FOUND,
            reader::error_page("找不到文章", "这篇文章不存在或尚未公开。"),
        ),
        Err(error) => {
            // Log through the same error path without exposing database details in HTML.
            let _ = error.into_response();
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                reader::error_page("暂时无法加载", "请稍后重试。"),
            )
        }
    };
    (status, [
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'self'; img-src https: http: data:; media-src https: http:; frame-src https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    ], Html(html)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    #[tokio::test]
    async fn invalid_requests_do_not_touch_the_database() {
        let app = router(AppState {
            library: Library::new(
                PgPoolOptions::new()
                    .connect_lazy("postgres://localhost/unused")
                    .unwrap(),
            ),
            app_origin: "https://bbs.example".into(),
            stylesheet: None,
            auth: None,
            refresh_pool: None,
        });
        for (path, status) in [
            ("/api/articles/not-an-id", 400),
            ("/api/articles?limit=-1", 400),
            ("/api/articles?limit=1.5", 400),
            ("/api/articles?scope=unknown", 400),
            ("/api/articles?cursor=bad", 400),
            ("/api/search?q=pid&cursor=bad", 400),
            ("/api/search?q=%22%22", 400),
            ("/api/search?q=", 400),
            ("/api/search", 400),
            ("/api/kb/browse?limit=-1", 400),
            ("/api/kb/entities?limit=1.5", 400),
            (
                "/api/articles/01J0000000000000000000000A/content?format=pdf",
                400,
            ),
            ("/articles/not-an-id", 404),
            ("/api/me", 503),
            ("/mcp", 404),
        ] {
            let res = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status().as_u16(), status, "{path}");
        }
    }
}
