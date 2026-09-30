use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
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
        .with_state(state)
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
) -> Result<String, ApiError> {
    let name = path.map_err(|_| ApiError::Invalid)?.0;
    let q = query.map_err(|_| ApiError::Invalid)?.0;
    if let Some(key) = q.key {
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
    let key = entity_request_key(path, query)?;
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
    let key = entity_request_key(path, query)?;
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
            ("/api/viewer", 404),
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
