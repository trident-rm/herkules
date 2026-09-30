//! Static Vite delivery and browser document fallback, without a JS server.
use std::{path::Path, sync::Arc};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde_json::Value;
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::{kb::entity_key, library::Library};

const OPEN: &str = "<!--bbs:head-->";
const CLOSE: &str = "<!--/bbs:head-->";

pub struct Document {
    plain: String,
    prefix: String,
    suffix: String,
}

impl Document {
    pub fn load(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Self::parse(std::fs::read_to_string(dir.join("index.html"))?).map_err(Into::into)
    }

    fn parse(plain: String) -> Result<Self, &'static str> {
        let a = plain
            .find(OPEN)
            .ok_or("index.html missing bbs:head marker")?;
        let b = plain
            .find(CLOSE)
            .ok_or("index.html missing /bbs:head marker")?;
        if b < a {
            return Err("index.html head markers out of order");
        }
        Ok(Self {
            prefix: plain[..a + OPEN.len()].into(),
            suffix: plain[b..].into(),
            plain,
        })
    }

    fn render(&self, meta: &Value, origin: &str) -> String {
        let text = |key| meta.get(key).and_then(Value::as_str).unwrap_or("");
        let title = escape(&format!("{} · RM 文库", text("title")));
        let collapsed = text("description")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let description = escape(&crate::library::truncate(&collapsed, 199));
        let url = escape(&format!("{origin}{}", text("path")));
        let mut tags = format!(
            "<title>{title}</title>\n<meta name=\"description\" content=\"{description}\">\n<link rel=\"canonical\" href=\"{url}\">\n<meta property=\"og:type\" content=\"{}\">\n<meta property=\"og:title\" content=\"{title}\">\n<meta property=\"og:description\" content=\"{description}\">\n<meta property=\"og:url\" content=\"{url}\">\n<meta property=\"og:site_name\" content=\"RM 文库\">",
            escape(text("type")),
        );
        for (key, property) in [
            ("image", "og:image"),
            ("publishedAt", "article:published_time"),
            ("author", "article:author"),
        ] {
            if !text(key).is_empty() {
                tags.push_str(&format!(
                    "\n<meta property=\"{property}\" content=\"{}\">",
                    escape(text(key))
                ));
            }
        }
        let card = if text("image").is_empty() {
            "summary"
        } else {
            "summary_large_image"
        };
        format!(
            "{}\n{tags}\n<meta name=\"twitter:card\" content=\"{card}\">\n{}",
            self.prefix, self.suffix
        )
    }
}

#[derive(Clone)]
struct WebState {
    document: Arc<Document>,
    files: ServeDir,
    library: Library,
    origin: String,
}

pub fn router(
    dir: &Path,
    library: Library,
    origin: String,
) -> Result<Router, Box<dyn std::error::Error>> {
    let state = WebState {
        document: Arc::new(Document::load(dir)?),
        files: ServeDir::new(dir).append_index_html_on_directories(false),
        library,
        origin,
    };
    Ok(Router::new().fallback(get(browser)).with_state(state))
}

async fn browser(State(state): State<WebState>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let asset = path.starts_with("/assets/");
    let public_file = asset
        || path.starts_with("/fonts/")
        || path == "/robots.txt"
        || path.starts_with("/favicon.");
    if public_file {
        let mut response = state.files.oneshot(request).await.unwrap().into_response();
        if response.status() == StatusCode::NOT_FOUND {
            return not_found();
        }
        if response.status() == StatusCode::OK {
            let policy = if asset {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=3600"
            };
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, policy.parse().unwrap());
        }
        response
            .headers_mut()
            .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
        return response;
    }
    // Reserved paths must never turn into a successful HTML document.
    if path == "/api" || path == "/mcp" || path.starts_with("/api/") || path.starts_with("/mcp/") {
        return not_found();
    }
    let mut status = StatusCode::OK;
    let mut body = state.document.plain.clone();
    if let Some(name) = path.strip_prefix("/kb/") {
        let name = name.strip_suffix('/').unwrap_or(name);
        if !name.contains('/') {
            match decode_segment(name) {
                Some(name) => match state.library.entity_head(&entity_key(&name)).await {
                    Ok(Some(meta)) => body = state.document.render(&meta, &state.origin),
                    Ok(None) => status = StatusCode::NOT_FOUND,
                    Err(error) => {
                        tracing::error!(%error, "KB document metadata unavailable");
                        return StatusCode::SERVICE_UNAVAILABLE.into_response();
                    }
                },
                None => status = StatusCode::NOT_FOUND,
            }
        }
    }
    (
        status,
        [
            (header::CACHE_CONTROL, "no-cache"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Html(body),
    )
        .into_response()
}

fn decode_segment(raw: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut source = raw.bytes();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let a = (source.next()? as char).to_digit(16)?;
            let b = (source.next()? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "not_found", "error_description": "no such route"
        })),
    )
        .into_response()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_and_paths_are_safe() {
        assert!(Document::parse("missing".into()).is_err());
        assert!(Document::parse(format!("{CLOSE}{OPEN}")).is_err());
        let doc = Document::parse(format!("before{OPEN}old{CLOSE}after")).unwrap();
        let html = doc.render(&serde_json::json!({"title":"\"><script>x</script>", "description":"a  b", "path":"/kb/x", "type":"website"}), "https://bbs.example");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("content=\"a b\""));
        assert!(html.contains("https://bbs.example/kb/x"));
        assert_eq!(decode_segment("%E6%9C%BA+%20"), Some("机+ ".into()));
        for bad in ["%", "%GG", "%FF"] {
            assert!(decode_segment(bad).is_none());
        }
    }
}
