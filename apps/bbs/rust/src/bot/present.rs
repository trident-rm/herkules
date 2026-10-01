use super::command::{SPECS, slice, units};
use crate::library::js_whitespace;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub msg_type: String,
    pub content: String,
    pub hash: String,
}
pub fn freeze(value: Value) -> Payload {
    let content = value.to_string();
    let hash = format!("{:x}", Sha256::digest(format!("interactive\0{content}")));
    Payload {
        msg_type: "interactive".into(),
        content,
        hash,
    }
}
pub fn md(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|c| match c {
            '[' => '［',
            ']' => '］',
            '*' => '＊',
            '~' => '～',
            '`' => 'ˋ',
            '<' => '＜',
            '>' => '＞',
            '#' => '＃',
            _ => c,
        })
        .collect();
    mapped
        .split(js_whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn clip(text: &str, max: usize) -> String {
    let short: String = text.chars().take(max - 1).collect();
    if text.chars().count() > max - 1 {
        format!("{short}…")
    } else {
        short
    }
}
fn string(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().into()
}
pub fn day(at: DateTime<Utc>) -> String {
    (at + Duration::hours(8)).format("%Y-%m-%d").to_string()
}
pub fn due(day: &str) -> Option<DateTime<Utc>> {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()?
        .succ_opt()?;
    Some(d.and_hms_opt(1, 0, 0)?.and_utc())
}
fn link(text: &str, url: &str) -> String {
    if url.to_lowercase().starts_with("http://") || url.to_lowercase().starts_with("https://") {
        format!("[{}]({url})", md(text))
    } else {
        md(text)
    }
}
fn markdown(text: impl Into<String>) -> Value {
    json!({"tag":"markdown","content":text.into()})
}
fn note(text: impl Into<String>) -> Value {
    markdown(format!("<font color='grey'>{}</font>", text.into()))
}
fn hr() -> Value {
    json!({"tag":"hr"})
}
fn button(text: &str, url: &str, primary: bool) -> Value {
    json!({"tag":"button","text":{"tag":"plain_text","content":text},"type":if primary{"primary"}else{"default"},"behaviors":[{"type":"open_url","default_url":url}]})
}
fn callback(text: &str, value: Value, primary: bool) -> Value {
    json!({"tag":"button","text":{"tag":"plain_text","content":text},"type":if primary{"primary"}else{"default"},"behaviors":[{"type":"callback","value":value}]})
}
fn row(buttons: Vec<Value>) -> Value {
    json!({"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":buttons.into_iter().map(|b|json!({"tag":"column","width":"auto","elements":[b]})).collect::<Vec<_>>()})
}
fn card(title: &str, elements: Vec<Value>, template: &str, subtitle: Option<&str>) -> Payload {
    let mut header = json!({"title":{"tag":"plain_text","content":title}});
    if let Some(s) = subtitle.filter(|s| !s.is_empty()) {
        header["subtitle"] = json!({"tag":"plain_text","content":s})
    }
    header["template"] = json!(template);
    freeze(
        json!({"schema":"2.0","config":{"wide_screen_mode":true,"update_multi":true},"header":header,"body":{"elements":elements}}),
    )
}
pub fn help(chat: &str) -> Payload {
    let lines = SPECS
        .iter()
        .map(|(_, _, usage, summary)| format!("**{usage}**  {summary}"))
        .collect::<Vec<_>>()
        .join("\n");
    let hint = if chat == "group" {
        "群聊中先 @机器人 再发送命令；「搜索 关键词」同样有效。"
    } else {
        "私聊中直接发送关键词即可全文搜索；也可以点击输入框旁的机器人菜单。"
    };
    card(
        "RM 文库机器人",
        vec![markdown(lines), hr(), note(hint)],
        "blue",
        Some("命令列表"),
    )
}
pub fn error(kind: &str, name: &str) -> Payload {
    let (title, detail) = match kind {
        "unknown" => ("未知命令", format!("`/{}` 不是可用命令。", md(name))),
        "too_long" => ("关键词太长", "搜索词不能超过 200 个字符。".into()),
        _ => (
            "缺少关键词",
            "请在命令后面输入要搜索的关键词，例如 `/search 云台 PID`。".into(),
        ),
    };
    card(
        title,
        vec![markdown(detail), note("发送 /help 查看全部命令。")],
        "red",
        None,
    )
}
fn meta(a: &Value) -> String {
    let mut parts = vec![];
    let author = string(a, "author");
    if !author.is_empty() {
        parts.push(md(&author))
    }
    if let Some(at) = a["publishedAt"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
    {
        parts.push(day(at.with_timezone(&Utc)))
    }
    if let Some(tags) = a["tags"].as_array() {
        for t in tags.iter().take(2).filter_map(Value::as_str) {
            let t = md(t.rsplit('/').next().unwrap_or(t));
            if !t.is_empty() {
                parts.push(t)
            }
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("<font color='grey'>{}</font>", parts.join(" · "))
    }
}
pub fn snippet(segments: &Value, budget: usize) -> String {
    let runs: Vec<_> = segments
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            let text = string(v, "text");
            let mut s = String::new();
            let mut space = false;
            for c in text.chars() {
                if js_whitespace(c) {
                    if !space {
                        s.push(' ')
                    }
                    space = true
                } else {
                    s.push(c);
                    space = false
                }
            }
            (s, v["hit"].as_bool().unwrap_or(false))
        })
        .filter(|(t, h)| *h || !t.is_empty())
        .collect();
    runs.iter()
        .enumerate()
        .map(|(i, (text, hit))| {
            if *hit {
                return format!("**{}**", md(text));
            }
            let n = units(text);
            let t = if n <= budget {
                text.clone()
            } else if i == 0 {
                format!("…{}", slice(text, n - budget, n))
            } else if i == runs.len() - 1 {
                format!("{}…", slice(text, 0, budget))
            } else {
                format!(
                    "{}…{}",
                    slice(text, 0, budget / 2),
                    slice(text, n - budget / 2, n)
                )
            };
            md(&t)
        })
        .collect::<String>()
        .trim_matches(js_whitespace)
        .into()
}
pub fn search(v: &Value) -> Payload {
    let query = string(v, "query");
    let scope = string(v, "scope");
    let origin = string(v, "appOrigin");
    let trail = v["trail"].as_array().cloned().unwrap_or_default();
    let items = v["page"]["items"].as_array().cloned().unwrap_or_default();
    let mut buttons = vec![];
    let base = json!({"v":1,"cmd":"search","q":query,"scope":scope,"chatType":v["chatType"],"nonce":v["nonce"]});
    if !trail.is_empty() {
        let mut b = base.clone();
        b["trail"] = json!(&trail[..trail.len() - 1]);
        buttons.push(callback("上一页", b, false))
    }
    if let Some(next) = v["page"]["nextCursor"].as_str().filter(|s| !s.is_empty()) {
        let mut next_trail = trail.clone();
        next_trail.push(json!(next));
        let mut b = base;
        b["trail"] = json!(next_trail);
        buttons.push(callback("下一页", b, true))
    }
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params.append_pair("q", &query);
    if scope != "all" {
        params.append_pair("scope", &scope);
    }
    buttons.push(button(
        "在网站中打开",
        &format!("{origin}/search?{}", params.finish()),
        false,
    ));
    let page = trail.len() + 1;
    let subtitle = format!(
        "{} · 第 {page} 页",
        match scope.as_str() {
            "title" => "仅标题",
            "kb" => "知识库",
            _ => "全文",
        }
    );
    let mut elements = vec![];
    if items.is_empty() {
        elements.push(markdown(if page == 1 {
            "没有找到匹配的文章。"
        } else {
            "这一页没有更多结果了。"
        }));
        elements.push(note(if scope == "all" {
            "试试更短或不同的关键词；/title 只搜标题，/kb 搜知识库。"
        } else {
            "试试 /search 在全文中查找。"
        }));
        elements.push(row(buttons));
        return card(
            &format!("搜索：{}", clip(&query, 40)),
            elements,
            "orange",
            Some(&subtitle),
        );
    }
    for (i, hit) in items.iter().enumerate() {
        if i > 0 {
            elements.push(hr())
        }
        let mut lines = vec![
            format!(
                "**{}. {}**",
                (page - 1) * 5 + i + 1,
                link(
                    &string(hit, "title"),
                    &format!("{origin}/articles/{}", string(hit, "id"))
                )
            ),
            meta(hit),
        ];
        if hit["snippet"].as_array().is_some_and(|s| !s.is_empty()) {
            lines.push(snippet(&hit["snippet"], 60))
        } else {
            lines.push(md(&clip(&string(hit, "excerpt"), 120)))
        }
        elements.push(markdown(
            lines
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        ))
    }
    elements.push(hr());
    elements.push(row(buttons));
    let terms = v["page"]["terms"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(md)
        .collect::<Vec<_>>()
        .join("、");
    elements.push(note(format!("匹配词：{terms} · 每页 5 条，与网站排序一致")));
    card(
        &format!("搜索：{}", clip(&query, 40)),
        elements,
        "blue",
        Some(&subtitle),
    )
}
pub fn latest(items: &[Value], origin: &str) -> Payload {
    let mut e = vec![];
    for (i, a) in items.iter().enumerate() {
        if i > 0 {
            e.push(hr())
        }
        let excerpt = a["tldr"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| a["excerpt"].as_str().unwrap_or_default());
        let lines = [
            format!(
                "**{}. {}**",
                i + 1,
                link(
                    &string(a, "title"),
                    &format!("{origin}/articles/{}", string(a, "id"))
                )
            ),
            meta(a),
            md(&clip(excerpt, 120)),
        ];
        e.push(markdown(
            lines
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        ))
    }
    if items.is_empty() {
        e.push(markdown("文库还没有收录文章。"))
    }
    e.extend([hr(), row(vec![button("打开文库", origin, true)])]);
    card("最新文章", e, "green", Some("按发布时间"))
}
pub fn status(s: &Value, origin: &str) -> Payload {
    let rows = [
        (
            "已收录",
            format!(
                "{} / {} 篇",
                s["articles"]["fetched"], s["articles"]["total"]
            ),
        ),
        ("标签", s["articles"]["tags"].to_string()),
        (
            "AI 摘要",
            format!(
                "{} 篇就绪，{} 篇待处理",
                s["ai"]["ready"], s["ai"]["missing"]
            ),
        ),
        ("知识库实体", s["ai"]["entities"].to_string()),
    ];
    let table = json!({"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","width":"weighted","weight":1,"elements":[markdown(rows.iter().map(|(l,_)|format!("<font color='grey'>{}</font>",md(l))).collect::<Vec<_>>().join("\n"))]},{"tag":"column","width":"weighted","weight":3,"elements":[markdown(rows.iter().map(|(_,v)|v.as_str()).collect::<Vec<_>>().join("\n"))]}]});
    card(
        &md(&string(&s["site"], "name")),
        vec![
            table,
            hr(),
            row(vec![button("状态页", &format!("{origin}/status"), false)]),
        ],
        "indigo",
        Some("收录情况"),
    )
}
pub fn article(a: &Value) -> Payload {
    let url = string(a, "articleLink");
    let mut e = vec![markdown(format!("**{}**", link(&string(a, "title"), &url)))];
    if let Some(excerpt) = a["excerpt"].as_str().filter(|s| !s.is_empty()) {
        e.push(markdown(md(&clip(excerpt, 200))))
    }
    e.push(row(vec![button("阅读全文", &url, true)]));
    card("RM 文库新文章", e, "green", None)
}
pub fn digest(day: &str, articles: &[Value]) -> Payload {
    let lines = articles
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let head = format!(
                "{}. {}",
                i + 1,
                link(&string(a, "title"), &string(a, "articleLink"))
            );
            if let Some(excerpt) = a["excerpt"].as_str().filter(|s| !s.is_empty()) {
                format!(
                    "{head}\n<font color='grey'>{}</font>",
                    md(&clip(excerpt, 80))
                )
            } else {
                head
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    card(
        &format!("{day} 新文章汇总"),
        vec![markdown(lines), note(format!("共 {} 篇", articles.len()))],
        "blue",
        Some("RM 文库"),
    )
}
