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
    library::{ContentFormat, Library, article_id},
    reader,
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
