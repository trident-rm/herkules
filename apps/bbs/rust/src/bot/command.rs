use crate::library::js_whitespace;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    pub chat_id: String,
    pub chat_type: String,
    pub content: String,
    pub raw_content_type: String,
    pub mentioned_bot: bool,
    pub create_time: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Help,
    Latest,
    Status,
    Ignore,
    Search { query: String, scope: String },
    Unknown { name: String },
    Invalid { reason: String },
}
pub const SPECS: [(&str, &[&str], &str, &str); 6] = [
    (
        "search",
        &["s", "搜索"],
        "/search 关键词",
        "全文搜索标题、作者、标签、简介和正文",
    ),
    ("title", &["t", "标题"], "/title 关键词", "只搜标题"),
    ("kb", &["知识库"], "/kb 关键词", "搜知识库条目"),
    ("latest", &["new", "最新"], "/latest", "最近收录的 5 篇文章"),
    ("status", &["状态"], "/status", "文库收录情况"),
    ("help", &["h", "?", "帮助"], "/help", "查看全部命令"),
];
fn find(word: &str) -> Option<&'static str> {
    let lower = word.to_lowercase();
    SPECS
        .iter()
        .find(|(name, aliases, _, _)| *name == lower || aliases.contains(&lower.as_str()))
        .map(|s| s.0)
}
pub fn units(s: &str) -> usize {
    s.encode_utf16().count()
}
pub fn slice(s: &str, start: usize, end: usize) -> String {
    let v: Vec<_> = s.encode_utf16().collect();
    String::from_utf16_lossy(&v[start.min(v.len())..end.min(v.len())])
}
fn resolve(name: &str, rest: &str) -> Command {
    match name {
        "help" => Command::Help,
        "latest" => Command::Latest,
        "status" => Command::Status,
        _ => {
            let query = rest.trim_matches(js_whitespace);
            if query.is_empty() {
                Command::Invalid {
                    reason: "empty".into(),
                }
            } else if units(query) > 200 {
                Command::Invalid {
                    reason: "too_long".into(),
                }
            } else {
                Command::Search {
                    query: query.into(),
                    scope: match name {
                        "title" => "title",
                        "kb" => "kb",
                        _ => "all",
                    }
                    .into(),
                }
            }
        }
    }
}
pub fn parse(m: &Message) -> Command {
    if (m.chat_type == "group" && !m.mentioned_bot) || m.raw_content_type != "text" {
        return Command::Ignore;
    }
    let text = m.content.trim_matches(js_whitespace);
    let split = if let Some(rest) = text
        .strip_prefix('/')
        .filter(|s| !s.is_empty() && !s.starts_with(js_whitespace))
    {
        let i = rest.find(js_whitespace).unwrap_or(rest.len());
        Some((&rest[..i], rest[i..].trim_start_matches(js_whitespace)))
    } else {
        let i = text.find(js_whitespace).unwrap_or(text.len());
        let first = &text[..i];
        if ["search", "help", "帮助", "搜索"].contains(&first.to_lowercase().as_str()) {
            Some((first, &text[i..]))
        } else {
            text.strip_prefix("搜索").map(|rest| ("搜索", rest))
        }
    };
    if let Some((word, rest)) = split {
        return find(word)
            .map(|name| resolve(name, rest))
            .unwrap_or_else(|| Command::Unknown {
                name: slice(word, 0, 40),
            });
    }
    if m.chat_type == "group" {
        Command::Ignore
    } else {
        resolve("search", text)
    }
}
pub fn menu(key: &str) -> Command {
    let key = key.trim_matches(js_whitespace);
    match find(key) {
        Some("search" | "title" | "kb") => Command::Help,
        Some(name) => resolve(name, ""),
        None => Command::Unknown {
            name: slice(key, 0, 40),
        },
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub v: u8,
    pub cmd: String,
    pub q: String,
    pub scope: String,
    pub trail: Vec<String>,
    pub chat_type: String,
    pub nonce: String,
}
pub fn action(mut value: Value) -> Option<Action> {
    if value["v"].as_f64() != Some(1.0) {
        return None;
    }
    value["v"] = json!(1);
    let a: Action = serde_json::from_value(value).ok()?;
    if a.v != 1
        || a.cmd != "search"
        || a.q.chars().count() == 0
        || a.q.chars().count() > 200
        || !["all", "title", "kb"].contains(&a.scope.as_str())
        || !["p2p", "group"].contains(&a.chat_type.as_str())
        || a.trail.len() > 50
        || a.trail
            .iter()
            .any(|s| s.chars().count() == 0 || s.chars().count() > 200)
        || a.nonce.chars().count() == 0
        || a.nonce.chars().count() > 64
    {
        return None;
    }
    Some(a)
}
pub fn receipt_id(message: &str, a: &Action) -> String {
    format!("action:{message}:{}:{}", a.nonce, a.trail.len())
}
pub fn as_value(c: Command) -> Value {
    serde_json::to_value(c).unwrap_or_else(|_| json!({"kind":"ignore"}))
}
