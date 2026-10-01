//! The public forum adapter. No login, redirects, alternate origins, or HTTP retries.
use super::{
    Error, Result, content,
    guard::{Guard, Priority},
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const ORIGIN: &str = "https://bbs.robomaster.com";
pub const USER_AGENT: &str = "rm-wenku/0.2 (+public article monitoring; rate limited; https://github.com/trident-rm/rm-wenku)";
pub const MAX_BODY: usize = 5 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub source_article_id: String,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub is_pinned: bool,
    pub introduction: Option<String>,
    pub tags: Vec<String>,
    pub listing_position: i32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub listed: Listed,
    pub format: String,
    pub raw: String,
    pub extracted: content::Extracted,
    pub parser_version: String,
}
#[derive(Debug)]
pub struct Listing {
    pub items: Vec<Listed>,
    pub is_last: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagDto {
    group_name: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Post {
    id: Option<Id>,
    title: Option<String>,
    introduction: Option<String>,
    author_nickname: Option<String>,
    create_at: Option<Time>,
    top: Option<bool>,
    tags: Option<Vec<TagDto>>,
    content_type: Option<String>,
    html_content: Option<String>,
    markdown_content: Option<String>,
    attachments: Option<Vec<File>>,
    file_items: Option<Vec<File>>,
    references: Option<Vec<Reference>>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Id {
    Number(f64),
    String(String),
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Time {
    Number(f64),
    String(String),
}
#[derive(Deserialize)]
struct File {
    src: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
struct Reference {
    url: Option<String>,
    title: Option<String>,
}
#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct Envelope<T> {
    success: Option<bool>,
    message: Option<String>,
    #[serde(deserialize_with = "required_data")]
    data: Option<T>,
}
#[derive(Deserialize)]
struct ListDto {
    total: Option<f64>,
    list: Option<Vec<Post>>,
}
fn required_data<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}
fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| content::clean(&s)).filter(|s| !s.is_empty())
}
fn invalid(message: impl Into<String>) -> Error {
    Error::Source {
        kind: "invalid",
        message: message.into(),
        retry: None,
    }
}
fn listed(p: &Post, position: i32) -> Result<Listed> {
    let id = match &p.id {
        Some(Id::String(s)) => s.clone(),
        Some(Id::Number(n)) => n.to_string(),
        None => return Err(invalid("post has no id")),
    };
    if id.is_empty() {
        return Err(invalid("post has no id"));
    }
    let title = clean(p.title.clone()).ok_or_else(|| invalid(format!("post {id} has no title")))?;
    let mut url = url::Url::parse(ORIGIN).expect("fixed origin");
    url.path_segments_mut()
        .expect("https URL")
        .extend(["article", &id]);
    url.set_query(Some("source=1"));
    let mut tags = Vec::new();
    for tag in p.tags.as_deref().unwrap_or_default() {
        let text = [clean(tag.group_name.clone()), clean(tag.name.clone())]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("/");
        if !text.is_empty() && !tags.contains(&text) {
            tags.push(text);
        }
    }
    Ok(Listed {
        source_article_id: id,
        url: url.into(),
        title,
        author: clean(p.author_nickname.clone()),
        published_at: p.create_at.as_ref().and_then(parse_time),
        is_pinned: p.top.unwrap_or(false),
        introduction: clean(p.introduction.clone()),
        tags,
        listing_position: position,
    })
}
fn parse_time(t: &Time) -> Option<DateTime<Utc>> {
    match t {
        Time::Number(n) => DateTime::from_timestamp_millis(*n as i64),
        Time::String(s) => {
            let s = s.trim();
            static RFC: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$").unwrap()
            });
            static NAIVE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(
                    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2}:[0-9]{2})?$",
                )
                .unwrap()
            });
            if RFC.is_match(s) {
                let d = DateTime::parse_from_rfc3339(s).ok()?;
                if d.nanosecond() >= 1_000_000_000 {
                    return None;
                }
                return DateTime::from_timestamp_millis(d.timestamp_millis());
            }
            if !NAIVE.is_match(s) {
                return None;
            }
            let d = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
                .ok()
                .or_else(|| {
                    NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .ok()?
                        .and_hms_opt(0, 0, 0)
                })?;
            if d.nanosecond() >= 1_000_000_000 {
                return None;
            }
            Some(d.and_utc() - chrono::Duration::hours(8))
        }
    }
}
pub fn parse_listing(json: Value, page: i32, size: i32) -> Result<Listing> {
    let e: Envelope<ListDto> = serde_json::from_value(json)
        .map_err(|e| invalid(format!("unexpected response shape: {e}")))?;
    if e.success == Some(false) {
        return Err(invalid(
            e.message.unwrap_or_else(|| "forum reported failure".into()),
        ));
    }
    let d = e.data.ok_or_else(|| invalid("missing listing data"))?;
    let posts = d.list.unwrap_or_default();
    let total = d.total.unwrap_or(posts.len() as f64);
    let items = posts
        .iter()
        .enumerate()
        .map(|(i, p)| listed(p, (page - 1) * size + i as i32))
        .collect::<Result<Vec<_>>>()?;
    let is_last = items.len() < size as usize || f64::from(page) * f64::from(size) >= total;
    Ok(Listing { items, is_last })
}
pub fn parse_detail(json: Value) -> Result<Detail> {
    let e: Envelope<Post> = serde_json::from_value(json)
        .map_err(|e| invalid(format!("unexpected response shape: {e}")))?;
    let post = e.data.ok_or_else(|| Error::Source {
        kind: "notFound",
        message: "not found".into(),
        retry: None,
    })?;
    if e.success == Some(false) {
        return Err(invalid(
            e.message.unwrap_or_else(|| "forum reported failure".into()),
        ));
    }
    let item = listed(&post, 0)?;
    let md = post.markdown_content.filter(|s| !s.trim().is_empty());
    let html = post.html_content.filter(|s| !s.trim().is_empty());
    let prefers_md = post
        .content_type
        .as_deref()
        .unwrap_or("")
        .eq_ignore_ascii_case("MARKDOWN");
    let (format, raw) = if let Some(md) = md.filter(|_| prefers_md || html.is_none()) {
        ("markdown", md)
    } else if let Some(h) = html {
        ("html", h)
    } else {
        return Err(invalid(format!(
            "post {} has no content",
            item.source_article_id
        )));
    };
    let mut extracted = content::extract(format, &raw, &item.url);
    for f in post
        .attachments
        .into_iter()
        .flatten()
        .chain(post.file_items.into_iter().flatten())
    {
        let src = f.src.unwrap_or_default();
        let name = clean(f.name);
        if content::is_image(&src, name.as_deref()) {
            extracted.add_image(&item.url, &src, name);
        } else {
            extracted.add_link(&item.url, &src, name);
        }
    }
    for r in post.references.into_iter().flatten() {
        extracted.add_link(&item.url, &r.url.unwrap_or_default(), clean(r.title));
    }
    Ok(Detail {
        listed: item,
        format: format.into(),
        raw,
        extracted,
        parser_version: "rm-api-v5".into(),
    })
}
#[derive(Clone)]
pub struct Source {
    client: reqwest::Client,
    guard: Guard,
}
impl Source {
    pub fn new(guard: Guard) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(std::time::Duration::from_secs(15))
            .user_agent(USER_AGENT)
            .build()?;
        Ok(Self { client, guard })
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let url = url::Url::parse(ORIGIN)?.join(path)?;
        if url.origin().ascii_serialization() != ORIGIN || url.scheme() != "https" {
            return Err(invalid("refusing URL outside forum origin"));
        }
        self.guard.acquire().await?;
        let result = self.request(url, body).await;
        let failure = match &result {
            Err(Error::Source { kind, retry, .. })
                if [
                    "forbidden",
                    "rateLimited",
                    "serverError",
                    "network",
                    "blocked",
                ]
                .contains(kind) =>
            {
                Some((*kind, *retry, result.as_ref().unwrap_err().to_string()))
            }
            Err(Error::Http(e)) => Some(("network", None, e.to_string())),
            _ => None,
        };
        match failure {
            Some((kind, retry, ref message)) => {
                self.guard.settle(Some((kind, retry, message))).await?
            }
            None => self.guard.settle(None).await?,
        }
        result
    }
    async fn request(&self, url: url::Url, body: Value) -> Result<Value> {
        let mut res = self
            .client
            .post(url)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = res.status().as_u16();
        let retry = res
            .headers()
            .get("retry-after")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|&s| s >= 0);
        if !(200..300).contains(&status) {
            let kind = match status {
                403 => "forbidden",
                404 => "notFound",
                429 => "rateLimited",
                500.. => "serverError",
                _ => "http",
            };
            return Err(Error::Source {
                kind,
                message: format!("http {status}"),
                retry,
            });
        }
        let json_type = res
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.to_lowercase().contains("json"));
        if res.content_length().is_some_and(|n| n > MAX_BODY as u64) {
            return Err(Error::Source {
                kind: "tooLarge",
                message: "response too large".into(),
                retry: None,
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(Error::Source {
                    kind: "tooLarge",
                    message: "response too large".into(),
                    retry: None,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::Source {
            kind: if json_type { "invalid" } else { "blocked" },
            message: if json_type {
                "body is not JSON"
            } else {
                "non-JSON response"
            }
            .into(),
            retry: None,
        })
    }
    pub async fn list(&self, page: i32, size: i32, _priority: Priority) -> Result<Listing> {
        if page < 1 || size < 1 {
            return Err(invalid("bad listing page"));
        }
        parse_listing(self.post("/developers-server/rest/posts/list",json!({"pageSize":size,"pageNo":page,"filter":{"category":"ARTICLE","sortByCreateAt":true,"tagIds":[]}})).await?,page,size)
    }
    pub async fn detail(&self, id: &str, _priority: Priority) -> Result<Detail> {
        if id.is_empty()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(invalid("bad post id"));
        }
        parse_detail(
            self.post(
                &format!("/developers-server/rest/posts/info/{id}"),
                json!({}),
            )
            .await?,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_envelope_is_not_a_missing_post() {
        assert!(matches!(
            parse_detail(json!({"success":true})),
            Err(Error::Source {
                kind: "invalid",
                ..
            })
        ));
        assert!(matches!(
            parse_detail(json!({"success":true,"data":null})),
            Err(Error::Source {
                kind: "notFound",
                ..
            })
        ));
    }
    #[test]
    fn dates() {
        for input in [
            "2026-01-02 12:00:00",
            "2026-01-02T12:00:00",
            "2026-01-02T04:00:00Z",
        ] {
            assert_eq!(
                parse_time(&Time::String(input.into()))
                    .unwrap()
                    .to_rfc3339(),
                "2026-01-02T04:00:00+00:00"
            );
        }
        for invalid in [
            "2026-02-30",
            "2026-1-1",
            "2026-01-02T04:00:00z",
            "2026-01-02T04:00:60Z",
            "2026-01-02 04:00:60",
        ] {
            assert!(
                parse_time(&Time::String(invalid.into())).is_none(),
                "{invalid}"
            );
        }
        let precise = parse_time(&Time::String("2026-01-02T04:00:00.999999Z".into())).unwrap();
        assert_eq!(precise.timestamp_subsec_nanos(), 999_000_000);
    }
}
#[cfg(test)]
mod http_tests {
    use super::*;
    use axum::{Router, body::Body, response::Response, routing::post};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    async fn fixture(
        status: u16,
        content_type: &str,
        body: Vec<u8>,
        extra: Option<(&str, &str)>,
    ) -> (url::Url, tokio::task::JoinHandle<()>) {
        let content_type = content_type.to_owned();
        let extra = extra.map(|(k, v)| (k.to_owned(), v.to_owned()));
        let app = Router::new().route(
            "/",
            post(move || {
                let body = body.clone();
                let ct = content_type.clone();
                let extra = extra.clone();
                async move {
                    let mut response = Response::builder()
                        .status(status)
                        .header("content-type", ct)
                        .header("retry-after", "180");
                    if let Some((k, v)) = extra {
                        response = response.header(k, v);
                    }
                    response.body(Body::from(body)).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (url, handle)
    }
    #[tokio::test]
    async fn response_failures_and_caps() {
        let source = Source::new(super::super::guard::test_guard()).unwrap();
        for (status, ct, body, kind) in [
            (403, "text/plain", "denied".into(), "forbidden"),
            (404, "text/plain", "missing".into(), "notFound"),
            (429, "text/plain", "limited".into(), "rateLimited"),
            (503, "text/plain", "unavailable".into(), "serverError"),
            (200, "text/html", "<html>challenge</html>".into(), "blocked"),
            (200, "application/json", "{broken".into(), "invalid"),
            (
                200,
                "application/json",
                " ".repeat(MAX_BODY + 1),
                "tooLarge",
            ),
        ] {
            let (url, handle) = fixture(status, ct, body.into_bytes(), None).await;
            let result = source.request(url, json!({})).await;
            handle.abort();
            assert!(
                matches!(result,Err(Error::Source {kind:k,..}) if k==kind),
                "{result:?}"
            );
        }
    }
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    #[tokio::test]
    async fn compressed_json_and_decoded_body_cap() {
        let source = Source::new(super::super::guard::test_guard()).unwrap();
        let small = gzip(b"{\"success\":true}");
        let (url, handle) = fixture(
            200,
            "application/json",
            small,
            Some(("content-encoding", "gzip")),
        )
        .await;
        assert_eq!(
            source.request(url, json!({})).await.unwrap(),
            json!({"success":true})
        );
        handle.abort();
        let large = gzip(&vec![b' '; MAX_BODY + 1]);
        let (url, handle) = fixture(
            200,
            "application/json",
            large,
            Some(("content-encoding", "gzip")),
        )
        .await;
        assert!(matches!(
            source.request(url, json!({})).await,
            Err(Error::Source {
                kind: "tooLarge",
                ..
            })
        ));
        handle.abort();
    }
    #[tokio::test]
    async fn redirects_are_never_followed() {
        let hits = Arc::new(AtomicUsize::new(0));
        let capture = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}/", listener.local_addr().unwrap());
        let sink = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(move || {
                    capture.fetch_add(1, Ordering::SeqCst);
                    async { "{}" }
                }),
            )
            .await
            .unwrap();
        });
        let (url, handle) =
            fixture(302, "text/plain", Vec::new(), Some(("location", &target))).await;
        let result = Source::new(super::super::guard::test_guard())
            .unwrap()
            .request(url, json!({}))
            .await;
        assert!(matches!(result, Err(Error::Source { kind: "http", .. })));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        handle.abort();
        sink.abort();
    }
}
