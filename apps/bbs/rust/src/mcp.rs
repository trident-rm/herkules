//! Native MCP presenters over the shared Rust library. rmcp owns protocol/transport.
use crate::{
    auth::Principal,
    feed::{FeedError, FeedQuery},
    kb::{EntityQuery, KbQuery, entity_key},
    library::{ContentFormat, Library, article_id},
    search::SearchError,
};
use axum::http::request::Parts;
use rmcp::{RoleServer, ServerHandler, model::*, service::RequestContext};
use serde_json::{Value, json};
#[derive(Clone)]
pub struct Mcp {
    pub library: Library,
}
fn protocol_error() -> ErrorData {
    ErrorData::internal_error("internal error", None)
}
fn db_error(e: sqlx::Error) -> ErrorData {
    tracing::error!(error=%e,"MCP corpus query failed");
    protocol_error()
}
fn result(value: Value, text: String) -> CallToolResult {
    serde_json::from_value(
        json!({"content":[{"type":"text","text":text}],"structuredContent":value}),
    )
    .unwrap()
}
fn failure(text: String) -> CallToolResult {
    serde_json::from_value(json!({"content":[{"type":"text","text":text}],"isError":true})).unwrap()
}
fn feed_error(e: FeedError) -> CallToolResult {
    failure(
        match e {
            FeedError::InvalidCursor => "invalid_cursor: unusable cursor",
            FeedError::InvalidQuery => "invalid_request: invalid query",
        }
        .into(),
    )
}
fn date(s: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| {
            (d + chrono::Duration::hours(8))
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}
fn optional(out: &mut Value, key: &str, value: &Value) {
    if value.as_str().is_some_and(|s| !s.is_empty()) {
        out[key] = value.clone()
    }
}
fn hit(v: &Value) -> Value {
    let mut out = json!({"id":v["id"],"title":v["title"],"date":date(v["publishedAt"].as_str().or_else(||v["discoveredAt"].as_str()).unwrap_or("")),"url":v["url"],"tags":v["tags"],"score":v.get("score").unwrap_or(&json!(0)),"bodyChars":v["bodyChars"]});
    for k in ["author", "excerpt", "tldr"] {
        optional(&mut out, k, &v[k]);
    }
    if let Some(segments) = v["snippet"].as_array() {
        let snippet: String = segments
            .iter()
            .map(|s| {
                if s["hit"] == true {
                    format!("[{}]", s["text"].as_str().unwrap_or(""))
                } else {
                    s["text"].as_str().unwrap_or("").into()
                }
            })
            .collect();
        if !snippet.is_empty() {
            out["snippet"] = json!(snippet)
        }
    }
    out
}
fn card(v: &Value) -> Value {
    let mut out = json!({"id":v["articleId"],"title":v["title"],"tldr":v["tldr"],"genre":v["genre"],"maturity":v["maturity"],"domain":v["domain"],"robotTypes":v["robotTypes"],"entities":v["entities"].as_array().map(|a|a.iter().take(8).collect::<Vec<_>>()).unwrap_or_default(),"pitfalls":v["pitfalls"].as_array().map(|a|a.iter().take(3).collect::<Vec<_>>()).unwrap_or_default()});
    for k in ["author", "problem"] {
        optional(&mut out, k, &v[k]);
    }
    if let Some(d) = v["publishedAt"].as_str() {
        out["date"] = json!(date(d))
    }
    out
}
fn slice(body: &str, offset: usize, max: usize) -> Value {
    let utf16: Vec<_> = body.encode_utf16().collect();
    let total = utf16.len();
    let mut start = offset.min(total);
    if start > 0 && start < total && (0xdc00..=0xdfff).contains(&utf16[start]) {
        start += 1
    }
    let mut end = start.saturating_add(max).min(total);
    if end > start && end < total && (0xd800..=0xdbff).contains(&utf16[end - 1]) {
        end -= 1
    }
    let mut out = json!({"text":String::from_utf16_lossy(&utf16[start..end]),"offset":start,"totalChars":total});
    if end < total {
        out["nextOffset"] = json!(end)
    }
    out
}
fn tools() -> Vec<Tool> {
    serde_json::from_str(include_str!("mcp-tools.json")).unwrap()
}
// The exported schemas pin the existing public metadata. Validate inputs and apply
// their defaults here; no protocol result is allowed to bypass the input boundary.
fn inputs(schema: &Value, input: &Value) -> Result<Value, ErrorData> {
    let object = input
        .as_object()
        .ok_or_else(|| ErrorData::invalid_params("arguments must be an object", None))?;
    let mut out = json!({});
    for (name, s) in schema["properties"].as_object().unwrap() {
        let value = object
            .get(name)
            .cloned()
            .or_else(|| s.get("default").cloned());
        let required = schema["required"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == name));
        if let Some(v) = value {
            let valid = match s["type"].as_str() {
                Some("string") => v.as_str().is_some_and(|x| {
                    s["minLength"]
                        .as_u64()
                        .is_none_or(|n| x.encode_utf16().count() >= n as usize)
                }),
                Some("integer") => v.as_f64().is_some_and(|n| {
                    n.fract() == 0.0
                        && n.abs() <= 9_007_199_254_740_991.0
                        && s["minimum"].as_f64().is_none_or(|m| n >= m)
                        && s["maximum"].as_f64().is_none_or(|m| n <= m)
                }),
                Some("boolean") => v.is_boolean(),
                Some("array") => v.as_array().is_some_and(|a| {
                    a.iter().all(|v| {
                        v.is_string()
                            && s["items"]["enum"]
                                .as_array()
                                .is_none_or(|opts| opts.contains(v))
                    })
                }),
                _ => false,
            };
            if !valid || s["enum"].as_array().is_some_and(|opts| !opts.contains(&v)) {
                return Err(ErrorData::invalid_params(format!("invalid {name}"), None));
            }
            out[name] = v;
        } else if required {
            return Err(ErrorData::invalid_params(format!("missing {name}"), None));
        }
    }
    Ok(out)
}
fn string(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_owned)
}
fn feed_query(v: &Value) -> FeedQuery {
    FeedQuery {
        q: string(v, "query"),
        scope: string(v, "scope"),
        tag: string(v, "tag"),
        group: string(v, "group"),
        cursor: string(v, "cursor"),
        limit: v["limit"].as_u64().map(|n| n.to_string()),
    }
}
impl Mcp {
    async fn tool(&self, name: &str, v: Value, p: &Principal) -> Result<CallToolResult, ErrorData> {
        let lib = &self.library;
        match name {
            "list_articles" | "search_articles" => {
                let (page, search) = if name == "search_articles" {
                    let q = match feed_query(&v).validate_search_with_bounds(false) {
                        Ok(q) => q,
                        Err(SearchError::Empty) => {
                            return Ok(failure(
                                "empty_query: search needs at least one term".into(),
                            ));
                        }
                        Err(SearchError::Query(e)) => return Ok(feed_error(e)),
                    };
                    (
                        serde_json::to_value(lib.search(q).await.map_err(db_error)?).unwrap(),
                        true,
                    )
                } else {
                    let q = match feed_query(&v).validate_with_bounds(false) {
                        Ok(q) => q,
                        Err(e) => return Ok(feed_error(e)),
                    };
                    (
                        serde_json::to_value(lib.feed(q).await.map_err(db_error)?).unwrap(),
                        false,
                    )
                };
                let items = page["items"].as_array().unwrap();
                let mut out = json!({if search{"hits"}else{"articles"}:items.iter().map(hit).collect::<Vec<_>>()});
                if search {
                    out["terms"] = page["terms"].clone()
                }
                let more = page["nextCursor"].as_str().is_some();
                if more {
                    out["nextCursor"] = page["nextCursor"].clone()
                }
                Ok(result(
                    out,
                    format!(
                        "{} 篇{}",
                        items.len(),
                        if more { "（还有更多）" } else { "" }
                    ),
                ))
            }
            "get_article" => {
                let raw = v["id"].as_str().unwrap();
                let Some(id) = article_id(raw) else {
                    return Ok(failure(format!("No article {raw}")));
                };
                let Some(article) = lib.article(&id).await.map_err(db_error)? else {
                    return Ok(failure(format!("No article {raw}")));
                };
                let a = serde_json::to_value(&article).unwrap();
                let mut out = hit(&a);
                optional(&mut out, "introduction", &a["introduction"]);
                let want = v["include"].as_array().unwrap();
                let has = |s: &str| want.iter().any(|v| v == s);
                if has("content") {
                    let format = if v["format"] == "markdown" {
                        ContentFormat::Markdown
                    } else {
                        ContentFormat::Text
                    };
                    if let Some(c) = lib.content(&id, format).await.map_err(db_error)? {
                        out["content"] = slice(
                            &c.body,
                            v["offset"].as_u64().unwrap() as usize,
                            v["max_chars"].as_u64().unwrap() as usize,
                        );
                        out["content"]["format"] = json!(c.format.as_str())
                    }
                }
                if has("overview") || has("kb") {
                    let ai = serde_json::to_value(lib.ai(&id).await.map_err(db_error)?).unwrap();
                    out["aiStatus"] = ai.get("status").cloned().unwrap_or(json!("pending"));
                    if has("overview") {
                        out["overview"] = ai["overview"].clone()
                    }
                    if has("kb") {
                        out["kb"] = ai["kb"].clone();
                        out["imageCaptions"] = ai.get("images").cloned().unwrap_or(json!([]))
                    }
                }
                if has("links") {
                    out["links"] = json!(
                        a["links"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|l| {
                                let mut x = json!({"url":l["url"],"kind":l["kind"]});
                                for k in ["label", "articleId"] {
                                    optional(&mut x, k, &l[k])
                                }
                                x
                            })
                            .collect::<Vec<_>>()
                    )
                }
                if has("images") {
                    out["images"] = json!(
                        a["images"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|im| {
                                let mut x = json!({"url":im["url"]});
                                optional(&mut x, "alt", &im["alt"]);
                                x
                            })
                            .collect::<Vec<_>>()
                    )
                }
                let text = if let Some(offset) = out["content"]["nextOffset"].as_u64() {
                    format!(
                        "{} (content continues at offset {offset} of {})",
                        article.title, out["content"]["totalChars"]
                    )
                } else {
                    article.title
                };
                Ok(result(out, text))
            }
            "get_overview" | "get_kb" => {
                let raw = v["id"].as_str().unwrap();
                let Some(id) = article_id(raw) else {
                    return Ok(failure(format!("No article {raw}")));
                };
                let Some(ai) = lib.ai(&id).await.map_err(db_error)? else {
                    return Ok(failure(format!("No article {raw}")));
                };
                let ai = serde_json::to_value(ai).unwrap();
                let (mut out, text) = if name == "get_overview" {
                    (
                        json!({"id":ai["articleId"],"status":ai["status"],"overview":ai["overview"]}),
                        ai["overview"]["tldr"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                format!("overview {}", ai["status"].as_str().unwrap())
                            }),
                    )
                } else {
                    (
                        json!({"id":ai["articleId"],"status":ai["status"],"kb":ai["kb"],"images":ai["images"]}),
                        ai["kb"]["problem"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("kb {}", ai["status"].as_str().unwrap())),
                    )
                };
                if name == "get_overview" {
                    for k in ["model", "error"] {
                        optional(&mut out, k, &ai[k])
                    }
                    if let Some(d) = ai["generatedAt"].as_str() {
                        out["generatedAt"] = json!(date(d))
                    }
                }
                Ok(result(out, text))
            }
            "search_kb" => {
                let q = KbQuery {
                    q: string(&v, "query"),
                    domain: string(&v, "domain"),
                    robot: string(&v, "robot"),
                    genre: string(&v, "genre"),
                    limit: v["limit"].as_u64().map(|n| n.to_string()),
                };
                let q = match q.validate_with_bounds(false) {
                    Ok(q) => q,
                    Err(e) => return Ok(feed_error(e)),
                };
                let mut out = lib.kb_browse(q).await.map_err(db_error)?;
                let count = out["cards"].as_array().unwrap().len();
                out["cards"] = json!(
                    out["cards"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(card)
                        .collect::<Vec<_>>()
                );
                let text = format!("{count} of {} entries", out["total"]);
                Ok(result(out, text))
            }
            "list_entities" => {
                let q = EntityQuery {
                    q: string(&v, "query"),
                    limit: v["limit"].as_u64().map(|n| n.to_string()),
                };
                let (q, limit) = match q.validate_with_bounds(false) {
                    Ok(q) => q,
                    Err(e) => return Ok(feed_error(e)),
                };
                let out = lib.entities(q, limit).await.map_err(db_error)?;
                let items = &out["items"];
                Ok(result(
                    json!({"entities":items}),
                    format!("{} entities", items.as_array().unwrap().len()),
                ))
            }
            "get_entity" => {
                let name = v["name"].as_str().unwrap();
                let Some(detail) = lib.entity(&entity_key(name)).await.map_err(db_error)? else {
                    return Ok(failure(format!("No entity {name}")));
                };
                let articles = detail["articles"].as_array().unwrap();
                let out = json!({"entity":detail["entity"],"articles":articles.iter().map(|a|{let mut out=json!({"id":a["articleId"],"title":a["title"],"tldr":a["tldr"]});optional(&mut out,"author",&a["author"]);if let Some(d)=a["publishedAt"].as_str(){out["date"]=json!(date(d))}
if v["compact"]==false{out["kb"]=a["kb"].clone()}out}).collect::<Vec<_>>()});
                Ok(result(
                    out,
                    format!(
                        "{}: {} 篇",
                        detail["entity"]["name"].as_str().unwrap(),
                        articles.len()
                    ),
                ))
            }
            "list_tags" => {
                let t = lib.tags().await.map_err(db_error)?;
                let text = format!(
                    "{} tags in {} groups over {} articles",
                    t.items.len(),
                    t.groups.len(),
                    t.total
                );
                Ok(result(serde_json::to_value(t).unwrap(), text))
            }
            "library_status" => {
                let s = lib.status().await.map_err(db_error)?;
                let imported = s["importedAt"].as_str().map(date).unwrap_or("never".into());
                let text = format!(
                    "{} articles, {} with AI output; imported {imported}",
                    s["articles"]["fetched"], s["ai"]["ready"]
                );
                Ok(result(
                    json!({"site":s["site"],"articles":s["articles"],"ai":s["ai"],"crawler":{"lastCheckedAt":s["crawler"]["lastCheckedAt"],"backfillCompletedAt":s["crawler"]["backfillCompletedAt"]},"importedAt":s["importedAt"],"caller":{"id":p.subject,"role":p.role}}),
                    text,
                ))
            }
            _ => Err(ErrorData::invalid_params("unknown tool", None)),
        }
    }
}
impl ServerHandler for Mcp {
    fn get_info(&self) -> ServerConfig {
        serde_json::from_value(json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"rm-wenku","version":"2.0.0"},"instructions":"RM 文库: the RoboMaster developer-forum archive — ~900 Chinese articles with tags, links and images, plus model-written overviews and knowledge-base entries for ~105 of them. Search is substring-based; prefer specific Chinese terms or part numbers. Every tool is read-only."})).unwrap()
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(serde_json::from_value(json!({"tools":tools()})).unwrap())
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let principal = ctx
            .extensions
            .get::<Parts>()
            .and_then(|p| p.extensions.get::<Principal>())
            .ok_or_else(protocol_error)?;
        let tool = tools()
            .into_iter()
            .find(|t| t.name == request.name)
            .ok_or_else(|| ErrorData::invalid_params("unknown tool", None))?;
        let schema = Value::Object((*tool.input_schema).clone());
        let v = inputs(&schema, &json!(request.arguments.unwrap_or_default()))?;
        self.tool(&request.name, v, principal).await.map(Into::into)
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(serde_json::from_str(include_str!("mcp-resources.json")).unwrap())
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let uri = &request.uri;
        let missing =
            || ErrorData::resource_not_found("Resource not found", Some(json!({"uri":uri})));
        let u = url::Url::parse(uri).map_err(|_| missing())?;
        if u.scheme() != "rm"
            || u.host_str() != Some("articles")
            || u.query().is_some()
            || u.fragment().is_some()
        {
            return Err(missing());
        }
        let parts: Vec<_> = u.path().trim_start_matches('/').split('/').collect();
        let id = article_id(parts[0]).ok_or_else(missing)?;
        let (mime, text) = match parts.as_slice() {
            [_] => {
                let c = self
                    .library
                    .content(&id, ContentFormat::Markdown)
                    .await
                    .map_err(db_error)?
                    .ok_or_else(missing)?;
                (
                    if c.format == ContentFormat::Markdown {
                        "text/markdown"
                    } else {
                        "text/plain"
                    },
                    c.body,
                )
            }
            [_, kind @ ("overview" | "kb")] => {
                let ai = serde_json::to_value(
                    self.library
                        .ai(&id)
                        .await
                        .map_err(db_error)?
                        .ok_or_else(missing)?,
                )
                .unwrap();
                let out = if *kind == "overview" {
                    json!({"status":ai["status"],"overview":ai["overview"]})
                } else {
                    json!({"status":ai["status"],"kb":ai["kb"],"images":ai["images"]})
                };
                ("application/json", out.to_string())
            }
            _ => return Err(missing()),
        };
        Ok(serde_json::from_value::<ReadResourceResult>(
            json!({"contents":[{"uri":uri,"mimeType":mime,"text":text}]}),
        )
        .unwrap()
        .into())
    }
}
