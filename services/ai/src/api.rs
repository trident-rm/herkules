//! The API host: key authentication, the route allowlist, and transparent forwarding.
//!
//! A request passes only if its method and path are on [`route`]'s list. The gateway reads
//! `model` from the JSON body to choose a backend and forwards the body bytes unchanged. It
//! strips the client's credentials, hop-by-hop headers and `Accept-Encoding`, adds the
//! backend's credentials, and streams the response back as it arrives. Dropping the
//! response body, as hyper does when the client leaves, drops the upstream request.

use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Instant,
};

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures_util::{Stream, StreamExt as _};
use serde_json::{Value, json};

use crate::{
    App,
    backends::{Entry, Inflight, Pick},
    db::{self, KeyOwner, NewBodies, NewRequest},
    keys, levels,
    usage::{self, Meter, Stats},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Forward,
    Models,
    Model(String),
}

/// The allowlist. Everything else, `/metrics` and `/health` included, is a 404.
pub fn route(method: &Method, path: &str) -> Option<Route> {
    const POST: &[&str] = &[
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/v1/responses",
        "/tokenize",
        "/detokenize",
        "/v1/tokenize",
        "/v1/detokenize",
        "/v1/token/encode",
        "/v1/token/decode",
    ];
    match *method {
        Method::POST if POST.contains(&path) => Some(Route::Forward),
        Method::GET if path == "/v1/models" => Some(Route::Models),
        Method::GET => path
            .strip_prefix("/v1/models/")
            .filter(|id| !id.is_empty())
            .map(|id| Route::Model(id.to_owned())),
        _ => None,
    }
}

/// An error in the shape the route's clients read: Anthropic's for `/v1/messages`, else
/// OpenAI's.
fn error(path: &str, status: StatusCode, message: &str) -> Response {
    let kind = match status {
        StatusCode::UNAUTHORIZED => "authentication_error",
        StatusCode::FORBIDDEN => "permission_error",
        StatusCode::NOT_FOUND => "not_found_error",
        StatusCode::PAYLOAD_TOO_LARGE => "request_too_large",
        StatusCode::SERVICE_UNAVAILABLE => "overloaded_error",
        s if s.is_server_error() => "api_error",
        _ => "invalid_request_error",
    };
    let body = if path.starts_with("/v1/messages") {
        json!({"type": "error", "error": {"type": kind, "message": message}})
    } else {
        json!({"error": {"message": message, "type": kind, "code": status.as_u16()}})
    };
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(body),
    )
        .into_response()
}

pub async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    let started = Instant::now();
    let at = Utc::now();
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    let Some(route) = route(&parts.method, &path) else {
        return error(&path, StatusCode::NOT_FOUND, "no such route");
    };
    let owner = match authenticate(&app, &parts.headers).await {
        Ok(owner) => owner,
        Err((status, message)) => return error(&path, status, message),
    };
    let models = app.backends.available_models();
    match route {
        Route::Models => {
            let data: Vec<Value> = models.iter().map(|m| app.backends.card(m)).collect();
            axum::Json(json!({"object": "list", "data": data})).into_response()
        }
        Route::Model(id) if models.contains(&id) => {
            axum::Json(app.backends.card(&id)).into_response()
        }
        Route::Model(_) => error(&path, StatusCode::NOT_FOUND, "model not found"),
        Route::Forward => {
            let bytes = match axum::body::to_bytes(body, app.config.max_request_bytes).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    return error(
                        &path,
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "request body too large or unreadable",
                    );
                }
            };
            let request_json = serde_json::from_slice::<Value>(&bytes).ok();
            let model = request_json
                .as_ref()
                .and_then(|v| v["model"].as_str().map(str::to_owned))
                // Tokenizer routes may leave the model out; with one model there is no doubt.
                .or_else(|| {
                    (models.len() == 1)
                        .then(|| models.first().cloned())
                        .flatten()
                });
            let level = app.levels.get().level(&owner.sub, model.as_deref());
            let record = Record {
                app: Arc::clone(&app),
                owner,
                at,
                started,
                method: parts.method.to_string(),
                route: path.clone(),
                model: model.clone(),
                backend: None,
                effort: request_json.as_ref().and_then(usage::effort),
                level,
                request: (level == levels::FULL).then(|| bytes.clone()),
                done: false,
            };
            forward(app, parts.method, &parts.uri, &parts.headers, bytes, record).await
        }
    }
}

async fn authenticate(
    app: &App,
    headers: &HeaderMap,
) -> Result<KeyOwner, (StatusCode, &'static str)> {
    let raw = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))
        .map(str::trim)
        .ok_or((StatusCode::UNAUTHORIZED, "missing API key"))?;
    if !keys::well_formed(raw) {
        return Err((StatusCode::UNAUTHORIZED, "invalid API key"));
    }
    let owner = db::key_owner(&app.db, &keys::hash(raw))
        .await
        .map_err(|e| {
            tracing::error!("key lookup: {e}");
            (StatusCode::SERVICE_UNAVAILABLE, "key lookup failed")
        })?
        .ok_or((StatusCode::UNAUTHORIZED, "invalid API key"))?;
    match app.membership.enabled(&owner.sub).await {
        Ok(true) => {}
        Ok(false) => {
            return Err((
                StatusCode::FORBIDDEN,
                "the key's owner is not an active Herkules member",
            ));
        }
        Err(e) => {
            tracing::warn!("{e}");
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "membership check unavailable",
            ));
        }
    }
    let (db, id) = (app.db.clone(), owner.id);
    tokio::spawn(async move {
        if let Err(e) = db::touch_key(&db, id).await {
            tracing::warn!("touch key: {e}");
        }
    });
    Ok(owner)
}

async fn forward(
    app: Arc<App>,
    method: Method,
    uri: &axum::http::Uri,
    client_headers: &HeaderMap,
    body: Bytes,
    mut record: Record,
) -> Response {
    let path = record.route.clone();
    let Some(model) = record.model.clone() else {
        record.finish(Outcome::refused(400));
        return error(&path, StatusCode::BAD_REQUEST, "model is required");
    };
    let entry: Arc<Entry> = match app.backends.pick(&model) {
        Pick::Backend(entry) => entry,
        Pick::Unknown => {
            record.finish(Outcome::refused(404));
            return error(
                &path,
                StatusCode::NOT_FOUND,
                &format!("model {model:?} is not served here"),
            );
        }
        Pick::Unavailable => {
            record.finish(Outcome::refused(503));
            return error(
                &path,
                StatusCode::SERVICE_UNAVAILABLE,
                &format!("no backend for {model:?} is available"),
            );
        }
    };
    record.backend = Some(entry.backend.name.clone());
    let inflight = Inflight::new(Arc::clone(&entry));
    let target = format!(
        "{}{}",
        entry.backend.url,
        uri.path_and_query().map_or(path.as_str(), |p| p.as_str())
    );
    let mut headers = request_headers(client_headers);
    // Without this the HTTP client may ask for gzip itself, and the log would hold
    // compressed bytes.
    headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    entry.backend.credential.apply(&mut headers);
    let upstream = match app
        .http
        .request(method, target)
        .headers(headers)
        .body(body)
        .send()
        .await
    {
        Ok(upstream) => upstream,
        Err(e) => {
            tracing::warn!(backend = %entry.backend.name, "upstream: {}", e.without_url());
            record.finish(Outcome {
                error: Some("the backend did not answer".into()),
                ..Outcome::refused(502)
            });
            return error(&path, StatusCode::BAD_GATEWAY, "the backend did not answer");
        }
    };
    let status = upstream.status();
    let meter = Meter::new(
        upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    );
    let mut response = Response::builder().status(status);
    if let Some(headers) = response.headers_mut() {
        for (name, value) in upstream.headers() {
            if keep_response_header(name) {
                headers.append(name, value.clone());
            }
        }
    }
    let keep = (record.level == levels::FULL).then(|| Capped::new(app.config.log_body_bytes));
    let tap = Tap::new(
        upstream.bytes_stream(),
        meter,
        keep,
        status.as_u16(),
        Box::new(move |outcome| record.finish(outcome)),
        Some(inflight),
    );
    response
        .body(Body::from_stream(tap))
        .unwrap_or_else(|_| error(&path, StatusCode::BAD_GATEWAY, "bad upstream response"))
}

/// Request headers that pass to the backend: none that identify the client to this gateway
/// or Cloudflare, no hop-by-hop headers, no `Accept-Encoding`.
pub fn request_headers(client: &HeaderMap) -> HeaderMap {
    let listed: Vec<String> = client
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .collect();
    let mut headers = HeaderMap::new();
    for (name, value) in client {
        let lower = name.as_str();
        let dropped = matches!(
            lower,
            "host"
                | "authorization"
                | "x-api-key"
                | "accept-encoding"
                | "content-length"
                | "cookie"
                | "forwarded"
                | "x-forwarded-for"
                | "x-forwarded-host"
                | "x-forwarded-proto"
                | "x-real-ip"
        ) || is_hop_by_hop(name)
            || lower.starts_with("cf-")
            || listed.iter().any(|l| l == lower);
        if !dropped {
            headers.append(name, value.clone());
        }
    }
    headers
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn keep_response_header(name: &HeaderName) -> bool {
    !is_hop_by_hop(name)
        && !name.as_str().starts_with("cf-")
        && !matches!(name.as_str(), "set-cookie" | "server" | "alt-svc")
}

/// The first `cap` bytes of a body, and how long it was.
struct Capped {
    data: Vec<u8>,
    total: usize,
    cap: usize,
}

impl Capped {
    fn new(cap: usize) -> Self {
        Self {
            data: Vec::new(),
            total: 0,
            cap,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let room = self.cap.saturating_sub(self.data.len());
        self.data.extend_from_slice(&chunk[..room.min(chunk.len())]);
    }
}

/// What the gateway knows about a request before it ends. Dropping an unfinished record
/// logs the request as cancelled: the client left before the response began.
pub struct Record {
    app: Arc<App>,
    owner: KeyOwner,
    at: DateTime<Utc>,
    started: Instant,
    method: String,
    route: String,
    model: Option<String>,
    backend: Option<String>,
    effort: Option<String>,
    level: &'static str,
    request: Option<Bytes>,
    done: bool,
}

impl Record {
    fn finish(&mut self, outcome: Outcome) {
        if self.done {
            return;
        }
        self.done = true;
        let Outcome {
            status,
            stats,
            streamed,
            cancelled,
            error,
            response,
        } = outcome;
        let row = NewRequest {
            at: self.at,
            sub: self.owner.sub.clone(),
            key_id: self.owner.id,
            model: self.model.take(),
            backend: self.backend.take(),
            method: std::mem::take(&mut self.method),
            route: std::mem::take(&mut self.route),
            status: i32::from(status),
            duration_ms: i32::try_from(self.started.elapsed().as_millis()).unwrap_or(i32::MAX),
            streamed,
            cancelled,
            effort: self.effort.take(),
            error: error.or_else(|| stats.error.clone()),
            stats,
            level: self.level,
        };
        let request = self.request.take();
        let cap = self.app.config.log_body_bytes;
        let db = self.app.db.clone();
        tokio::spawn(async move {
            let bodies = match request {
                Some(request) => {
                    let response = response.unwrap_or_else(|| Capped::new(0));
                    tokio::task::spawn_blocking(move || compress(&request, cap, &response))
                        .await
                        .ok()
                }
                None => None,
            };
            if let Err(e) = db::insert_request(&db, &row, bodies.as_ref()).await {
                tracing::error!("request log: {e}");
            }
        });
    }
}

impl Drop for Record {
    fn drop(&mut self) {
        self.finish(Outcome {
            cancelled: true,
            ..Outcome::refused(499)
        });
    }
}

/// How a request ended, for its log row.
pub struct Outcome {
    status: u16,
    stats: Stats,
    streamed: bool,
    /// The client left before the response ended.
    cancelled: bool,
    /// The gateway's own error, such as an upstream that stopped sending.
    error: Option<String>,
    response: Option<Capped>,
}

impl Outcome {
    fn refused(status: u16) -> Self {
        Self {
            status,
            stats: Stats::default(),
            streamed: false,
            cancelled: false,
            error: None,
            response: None,
        }
    }
}

fn compress(request: &[u8], cap: usize, response: &Capped) -> NewBodies {
    let zstd = |bytes: &[u8]| zstd::encode_all(bytes, 3).unwrap_or_default();
    let kept = &request[..request.len().min(cap)];
    let size = |n: usize| i32::try_from(n).unwrap_or(i32::MAX);
    NewBodies {
        request: zstd(kept),
        request_bytes: size(request.len()),
        request_truncated: request.len() > cap,
        response: zstd(&response.data),
        response_bytes: size(response.total),
        response_truncated: response.total > response.data.len(),
    }
}

/// The HTTP client for backends: connections time out after 10 s, and a response that sends
/// no byte for `idle` fails. There is no total timeout, since generations run long; Siphon
/// sends keep-alive bytes well within `idle`, streamed or not.
pub fn upstream_client(idle: std::time::Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(idle)
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

type Finish = Box<dyn FnOnce(Outcome) + Send>;

/// The response body: passes each chunk to the client as it arrives, never holding a whole
/// body, reads usage and timings from the bytes, keeps them for a `full` log, and reports how
/// the response ended.
struct Tap {
    inner: Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>,
    meter: Option<Meter>,
    keep: Option<Capped>,
    status: u16,
    done: Option<Finish>,
    _inflight: Option<Inflight>,
}

impl Tap {
    fn new(
        inner: impl Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
        meter: Meter,
        keep: Option<Capped>,
        status: u16,
        done: Finish,
        inflight: Option<Inflight>,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            meter: Some(meter),
            keep,
            status,
            done: Some(done),
            _inflight: inflight,
        }
    }

    fn finish(&mut self, cancelled: bool, error: Option<String>) {
        let (Some(done), Some(meter)) = (self.done.take(), self.meter.take()) else {
            return;
        };
        let streamed = meter.streamed();
        done(Outcome {
            status: self.status,
            stats: meter.finish(),
            streamed,
            cancelled,
            error,
            response: self.keep.take(),
        });
    }
}

impl Stream for Tap {
    type Item = reqwest::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let polled = self.inner.poll_next_unpin(cx);
        match &polled {
            Poll::Ready(Some(Ok(chunk))) => {
                if let Some(meter) = self.meter.as_mut() {
                    meter.feed(chunk);
                }
                if let Some(keep) = self.keep.as_mut() {
                    keep.push(chunk);
                }
            }
            // An upstream failure mid-body, such as the idle timeout, ends the client's
            // response too.
            Poll::Ready(Some(Err(e))) => {
                let message = format!("upstream: {}", without_url(e));
                self.finish(false, Some(message));
            }
            Poll::Ready(None) => self.finish(false, None),
            Poll::Pending => {}
        }
        polled
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.finish(true, None);
    }
}

fn without_url(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    if let Some(url) = error.url() {
        text = text.replace(url.as_str(), "backend");
    }
    if error.is_timeout() {
        text.push_str(" (idle timeout)");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        assert_eq!(
            route(&Method::POST, "/v1/chat/completions"),
            Some(Route::Forward)
        );
        assert_eq!(
            route(&Method::POST, "/v1/messages/count_tokens"),
            Some(Route::Forward)
        );
        assert_eq!(route(&Method::POST, "/tokenize"), Some(Route::Forward));
        assert_eq!(route(&Method::GET, "/v1/models"), Some(Route::Models));
        assert_eq!(
            route(&Method::GET, "/v1/models/org/model"),
            Some(Route::Model("org/model".into()))
        );
        for (method, path) in [
            (Method::GET, "/metrics"),
            (Method::GET, "/health"),
            (Method::GET, "/version"),
            (Method::GET, "/v1/chat/completions"),
            (Method::POST, "/v1/models"),
            (Method::GET, "/v1/models/"),
            (Method::POST, "/v1/chat/completions/"),
            (Method::DELETE, "/v1/responses"),
        ] {
            assert_eq!(route(&method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn strips_client_credentials_and_hop_by_hop_headers() {
        let mut client = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Bearer sk-hk-x"),
            ("x-api-key", "sk-hk-x"),
            ("accept-encoding", "gzip"),
            ("connection", "keep-alive, x-private"),
            ("x-private", "1"),
            ("keep-alive", "timeout=5"),
            ("cf-connecting-ip", "192.0.2.1"),
            ("cf-access-client-secret", "x"),
            ("cookie", "a=b"),
            ("host", "ai-api.example"),
            ("content-length", "10"),
            ("x-forwarded-for", "192.0.2.1"),
            ("content-type", "application/json"),
            ("anthropic-version", "2023-06-01"),
            ("x-request-id", "abc"),
        ] {
            client.append(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        let kept = request_headers(&client);
        let mut names: Vec<_> = kept.keys().map(HeaderName::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, ["anthropic-version", "content-type", "x-request-id"]);
    }

    #[test]
    fn errors_follow_the_route_protocol() {
        let anthropic = error("/v1/messages", StatusCode::UNAUTHORIZED, "no");
        assert_eq!(anthropic.status(), StatusCode::UNAUTHORIZED);
        let openai = error("/v1/chat/completions", StatusCode::NOT_FOUND, "no");
        assert_eq!(openai.status(), StatusCode::NOT_FOUND);
    }

    /// A backend that sends a 200 at once, then each `(delay, bytes)` step, then closes.
    async fn trickling_backend(steps: Vec<(std::time::Duration, &'static [u8])>) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0; 1];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n")
                .await
                .unwrap();
            for (delay, bytes) in steps {
                tokio::time::sleep(delay).await;
                if socket.write_all(bytes).await.is_err() {
                    return;
                }
                socket.flush().await.unwrap();
            }
        });
        format!("http://{address}/v1/chat/completions")
    }

    async fn through_tap(
        url: &str,
    ) -> (
        Vec<(std::time::Duration, Bytes)>,
        Result<(), String>,
        Outcome,
    ) {
        let client = upstream_client(std::time::Duration::from_secs(2)).unwrap();
        let started = Instant::now();
        let upstream = client.get(url).send().await.unwrap();
        let meter = Meter::new(Some("application/json"));
        let (tx, rx) = std::sync::mpsc::channel();
        let tap = Tap::new(
            upstream.bytes_stream(),
            meter,
            None,
            200,
            Box::new(move |outcome| tx.send(outcome).unwrap()),
            None,
        );
        let mut body = Body::from_stream(tap).into_data_stream();
        let mut chunks = Vec::new();
        let mut result = Ok(());
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => chunks.push((started.elapsed(), chunk)),
                Err(e) => {
                    result = Err(e.to_string());
                    break;
                }
            }
        }
        drop(body);
        (chunks, result, rx.recv().unwrap())
    }

    #[tokio::test]
    async fn a_trickling_upstream_gets_through_under_the_idle_timeout() {
        let second = std::time::Duration::from_secs(1);
        let json: &'static [u8] =
            br#"{"usage":{"prompt_tokens":3,"completion_tokens":2},"timings":{"prompt_n":3,"cache_n":0,"predicted_n":2,"ttft_ms":5000.0}}"#;
        let mut steps = vec![(second, &b" "[..]); 5];
        steps.push((second, json));
        let url = trickling_backend(steps).await;
        let (chunks, result, outcome) = through_tap(&url).await;
        result.unwrap();
        // Each byte reaches the client as it arrives, not when the body ends.
        assert!(
            chunks[0].0 < std::time::Duration::from_millis(1900),
            "{:?}",
            chunks[0].0
        );
        let body: Vec<u8> = chunks.iter().flat_map(|(_, c)| c.to_vec()).collect();
        assert!(body.starts_with(b"     {"));
        assert!(serde_json::from_slice::<Value>(&body).is_ok());
        assert_eq!(outcome.stats.output_tokens, Some(2));
        assert_eq!(outcome.stats.ttft_ms, Some(5000.0));
        assert!(!outcome.cancelled && outcome.error.is_none());
    }

    #[tokio::test]
    async fn an_upstream_silent_past_the_idle_timeout_fails_as_an_error() {
        let url = trickling_backend(vec![
            (std::time::Duration::from_millis(200), &b" "[..]),
            (std::time::Duration::from_secs(3), &b"{}"[..]),
        ])
        .await;
        let (chunks, result, outcome) = through_tap(&url).await;
        assert_eq!(chunks.len(), 1);
        assert!(result.is_err());
        let error = outcome.error.unwrap();
        assert!(error.contains("idle timeout"), "{error}");
        assert!(!outcome.cancelled);
    }

    #[test]
    fn capped_keeps_the_head_and_the_length() {
        let mut capped = Capped::new(4);
        capped.push(b"abc");
        capped.push(b"def");
        assert_eq!(capped.data, b"abcd");
        assert_eq!(capped.total, 6);
        let bodies = compress(b"0123456789", 4, &capped);
        assert!(bodies.request_truncated && bodies.response_truncated);
        assert_eq!(zstd::decode_all(&bodies.request[..]).unwrap(), b"0123");
        assert_eq!(bodies.request_bytes, 10);
    }
}
