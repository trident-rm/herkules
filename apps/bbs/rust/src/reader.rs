use std::{fs, path::Path};

use crate::{
    ai::ArticleAi,
    library::{Article, article_id, collapse, truncate},
};
use askama::Template;
use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;

pub struct Stylesheet {
    pub url: String,
}
impl Stylesheet {
    /// Use the same Vite asset build as the SPA; no separate CSS token definitions.
    pub fn load(web_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(web_dir.join(".vite/manifest.json"))?)?;
        let file = manifest
            .get("src/ssr.css")
            .and_then(|v| v.get("file"))
            .and_then(serde_json::Value::as_str)
            .ok_or("Vite manifest is missing src/ssr.css; run the BBS web build")?;
        if !file.starts_with("assets/") || file.contains("..") || !file.ends_with(".css") {
            return Err("invalid SSR stylesheet path in Vite manifest".into());
        }
        fs::metadata(web_dir.join(file))?;
        Ok(Self {
            url: format!("/{file}"),
        })
    }
}

#[derive(Template)]
#[template(path = "article.html")]
struct ArticlePage<'a> {
    article: &'a Article,
    description: String,
    body_html: Option<String>,
    headings: Vec<Heading>,
    resources: Vec<Resource>,
    pictures: Vec<Resource>,
    ai_message: Option<String>,
    ai_panels: Vec<Panel>,
    kb_panels: Vec<Panel>,
    model: Option<&'a str>,
    canonical: String,
    source_url: Option<&'a str>,
    stylesheet: Option<&'a str>,
    image: Option<&'a str>,
}

fn http_url(raw: &str) -> Option<&str> {
    url::Url::parse(raw)
        .ok()
        .filter(|u| {
            matches!(u.scheme(), "https" | "http")
                && u.username().is_empty()
                && u.password().is_none()
        })
        .map(|_| raw)
}

pub fn render(
    article: &Article,
    ai: Option<&ArticleAi>,
    origin: &str,
    stylesheet: Option<&str>,
) -> Result<String, askama::Error> {
    let (body_html, headings) = article
        .content_html
        .as_deref()
        .map(prepare_headings)
        .map_or((None, vec![]), |(html, headings)| (Some(html), headings));
    let (ai_panels, kb_panels) = ai.map_or((vec![], vec![]), |ai| {
        (
            overview_panels(ai.overview.as_ref()),
            kb_panels(ai.kb.as_ref()),
        )
    });
    let ai_message = match ai {
        None => Some("AI 概览加载失败。".into()),
        Some(ai) if ai.status == "failed" => Some(format!(
            "概览生成失败{}。",
            ai.error
                .as_deref()
                .map(|e| format!("：{e}"))
                .unwrap_or_default()
        )),
        Some(ai) if ai.overview.is_none() => Some("这篇文章的 AI 概览尚未生成。".into()),
        _ => None,
    };
    ArticlePage {
        article,
        body_html,
        headings,
        resources: article
            .links
            .iter()
            .filter_map(|link| {
                let local = link.article_id.as_deref().and_then(article_id);
                let href = match local {
                    Some(id) => format!("/articles/{id}"),
                    None => http_url(&link.url)?.into(),
                };
                Some(Resource {
                    href,
                    label: link
                        .label
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| link.url.clone()),
                    kind: if link.article_id.is_some() {
                        "本站"
                    } else {
                        match link.kind.as_str() {
                            "repository" => "仓库",
                            "document" => "文档",
                            "download" => "下载",
                            "video" => "视频",
                            "cloud_drive" => "网盘",
                            _ => "链接",
                        }
                    },
                })
            })
            .collect(),
        pictures: article
            .images
            .iter()
            .enumerate()
            .filter_map(|(i, image)| {
                Some(Resource {
                    href: http_url(&image.url)?.into(),
                    label: image
                        .alt
                        .clone()
                        .unwrap_or_else(|| format!("图片 {}", i + 1)),
                    kind: "图片",
                })
            })
            .collect(),
        ai_message,
        ai_panels,
        kb_panels,
        model: ai.and_then(|ai| ai.model.as_deref()),
        description: truncate(
            &collapse(article.excerpt.as_deref().unwrap_or(&article.title)),
            199,
        ),
        canonical: format!("{origin}/articles/{}", article.id),
        source_url: http_url(&article.url),
        stylesheet,
        image: article
            .images
            .first()
            .and_then(|image| http_url(&image.url)),
    }
    .render()
}

#[derive(Debug)]
struct Heading {
    id: String,
    level: String,
    text: String,
}
struct Resource {
    href: String,
    label: String,
    kind: &'static str,
}
struct Panel {
    title: &'static str,
    rows: Vec<PanelRow>,
}
struct PanelRow {
    text: String,
    href: Option<String>,
}

static HEADINGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<h([23])(\s[^>]*)?>(.*?)</h([23])>").unwrap());
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
static ENTITIES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&(amp|lt|gt|quot|#39|nbsp);").unwrap());
static IDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"\s+id=(?:"[^"]*"|'[^']*')"#).unwrap());
fn prepare_headings(html: &str) -> (String, Vec<Heading>) {
    let mut headings = vec![];
    let html = HEADINGS
        .replace_all(html, |cap: &Captures<'_>| {
            if cap[1] != cap[4] {
                return cap[0].into();
            }
            let text = TAGS.replace_all(&cap[3], "");
            let text = ENTITIES.replace_all(&text, |c: &Captures<'_>| match &c[1] {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "#39" => "'",
                _ => " ",
            });
            let text = collapse(&text).trim().to_string();
            if text.is_empty() {
                return cap[0].into();
            }
            let id = format!("sec-{}", headings.len() + 1);
            headings.push(Heading {
                id: id.clone(),
                level: cap[1].into(),
                text,
            });
            let attrs = IDS.replace_all(cap.get(2).map_or("", |m| m.as_str()), "");
            format!(
                "<h{} id=\"{}\"{}>{}</h{}>",
                &cap[1], id, attrs, &cap[3], &cap[1]
            )
        })
        .into_owned();
    (html, headings)
}
fn add_panel(panels: &mut Vec<Panel>, title: &'static str, value: &Value, fields: &[&str]) {
    let values = match value {
        Value::Array(xs) => xs.clone(),
        Value::Null => vec![],
        other => vec![other.clone()],
    };
    let rows = values
        .iter()
        .filter_map(|v| {
            let text = if fields.is_empty() {
                v.as_str().unwrap_or("").into()
            } else {
                fields
                    .iter()
                    .filter_map(|key| v[key].as_str())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ")
            };
            if text.is_empty() {
                None
            } else {
                Some(PanelRow {
                    text,
                    href: v
                        .get("url")
                        .and_then(Value::as_str)
                        .and_then(http_url)
                        .map(String::from),
                })
            }
        })
        .collect::<Vec<_>>();
    if !rows.is_empty() {
        panels.push(Panel { title, rows });
    }
}
fn overview_panels(overview: Option<&Value>) -> Vec<Panel> {
    let mut panels = vec![];
    if let Some(v) = overview {
        for (label, key) in [
            ("类型", "genre"),
            ("一句话", "tldr"),
            ("摘要", "summary"),
            ("要点", "keyPoints"),
            ("适用", "appliesWhen"),
            ("内容", "package"),
            ("注意", "caveats"),
            ("阅读建议", "readingGuide"),
        ] {
            add_panel(&mut panels, label, &v[key], &[]);
        }
        add_panel(
            &mut panels,
            "成熟度",
            &v["maturity"],
            &["status", "evidence"],
        );
        let extras = &v["extras"];
        for (label, key) in [
            ("主张", "thesis"),
            ("快速开始", "quickStart"),
            ("移植清单", "portingChecklist"),
            ("兼容性", "compat"),
            ("可以直接做的", "actions"),
        ] {
            add_panel(&mut panels, label, &extras[key], &[]);
        }
        add_panel(
            &mut panels,
            "经验",
            &extras["lessons"],
            &["constraint", "decision", "outcome", "transferable"],
        );
        add_panel(
            &mut panels,
            "论点",
            &extras["arguments"],
            &["claim", "evidence"],
        );
        add_panel(
            &mut panels,
            "常见问题",
            &v["faq"],
            &["question", "answer", "source"],
        );
    }
    panels
}
fn kb_panels(kb: Option<&Value>) -> Vec<Panel> {
    let mut panels = vec![];
    if let Some(v) = kb {
        for (label, key) in [
            ("领域", "domain"),
            ("机器人类型", "robotTypes"),
            ("问题", "problem"),
            ("路线", "approach"),
            ("接口", "interfaces"),
            ("工具链", "toolchain"),
            ("踩坑", "pitfalls"),
            ("成本", "cost"),
            ("相关条目", "entities"),
            ("没说清的", "openQuestions"),
        ] {
            add_panel(&mut panels, label, &v[key], &[]);
        }
        for (label, key, fields) in [
            (
                "参数",
                "parameters",
                &["name", "value", "unit", "context", "source"][..],
            ),
            (
                "组件",
                "components",
                &["name", "kind", "spec", "role", "source"][..],
            ),
            (
                "取舍",
                "designDecisions",
                &["decision", "alternatives", "rationale", "source"][..],
            ),
            ("作者主张", "claims", &["claim", "evidence", "source"][..]),
            ("参考", "references", &["title", "relation"][..]),
        ] {
            add_panel(&mut panels, label, &v[key], fields);
        }
    }
    panels
}

#[derive(Template)]
#[template(path = "error.html")]
struct ErrorPage<'a> {
    title: &'a str,
    message: &'a str,
}

pub fn error_page(title: &str, message: &str) -> String {
    ErrorPage { title, message }
        .render()
        .expect("static error template")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn headings_have_unique_safe_anchors_and_decoded_labels() {
        let (html, headings) = prepare_headings(
            r#"<h2 id="old">A &amp; <b>B</b></h2><h3>A &lt;img&gt;</h3><h2> </h2>"#,
        );
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].text, "A & B");
        assert_eq!(headings[1].text, "A <img>");
        assert!(html.contains(r#"<h2 id="sec-1">"#));
        assert!(!html.contains("old"));
        assert!(html.contains(r#"<h3 id="sec-2">"#));
    }
    #[test]
    fn only_http_links_can_be_rendered() {
        assert!(http_url("javascript:alert(1)").is_none());
        assert!(http_url("https://user@example.com").is_none());
        assert_eq!(
            http_url("https://bbs.example/article/1"),
            Some("https://bbs.example/article/1")
        );
    }
    #[test]
    fn error_templates_escape_text() {
        let html = error_page("<script>alert(1)</script>", "<img onerror=x>");
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("lang=\"zh-CN\""));
    }
}
