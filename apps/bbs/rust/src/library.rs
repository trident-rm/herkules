//! Corpus reads shared by HTTP and Askama. SQL and Postgres types stop here.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};

#[derive(Clone)]
pub struct Library {
    pool: PgPool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleParts {
    pub season: Option<String>,
    pub team: Option<String>,
    pub labels: Vec<String>,
    pub topic: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleLink {
    pub url: String,
    pub kind: String,
    pub label: Option<String>,
    pub article_id: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleImage {
    pub url: String,
    pub alt: Option<String>,
    pub position: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub source_article_id: String,
    pub url: String,
    pub title: String,
    pub title_parts: TitleParts,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub discovered_at: String,
    pub fetched_at: Option<String>,
    pub is_pinned: bool,
    pub tags: Vec<String>,
    pub introduction: Option<String>,
    pub excerpt: Option<String>,
    pub body_chars: i32,
    pub link_count: i32,
    pub image_count: i32,
    pub tldr: Option<String>,
    pub content_format: Option<String>,
    pub content_html: Option<String>,
    pub body_text: Option<String>,
    pub links: Vec<ArticleLink>,
    pub images: Vec<ArticleImage>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentFormat {
    #[default]
    Text,
    Markdown,
    Html,
}

impl ContentFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Markdown => "markdown",
            Self::Html => "html",
        }
    }
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Text => "text/plain; charset=utf-8",
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Html => "text/html; charset=utf-8",
        }
    }
}

pub struct ArticleContent {
    pub format: ContentFormat,
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagCount {
    pub name: String,
    pub count: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TagIndex {
    pub items: Vec<TagCount>,
    pub groups: Vec<TagCount>,
    pub total: i32,
}

impl Library {
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn healthy(&self) -> bool {
        sqlx::query("SELECT id FROM articles LIMIT 0")
            .execute(&self.pool)
            .await
            .is_ok()
    }

    /// One query, including ordered links/images and ready-AI tldr. Never expose non-fetched rows.
    pub async fn article(&self, id: &str) -> Result<Option<Article>, sqlx::Error> {
        let row = sqlx::query(include_str!("sql/article.sql"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        let introduction: Option<String> = row.try_get("introduction")?;
        let body_head: Option<String> = row.try_get("body_head")?;
        let title: String = row.try_get("title")?;
        let content_format: Option<String> = row.try_get("content_format")?;
        let links: Value = row.try_get("links")?;
        let images: Value = row.try_get("images")?;
        let mut links: Vec<ArticleLink> =
            serde_json::from_value(links).map_err(|e| sqlx::Error::Decode(Box::new(e)))?;
        for link in &mut links {
            if ![
                "repository",
                "document",
                "download",
                "video",
                "cloud_drive",
                "other",
            ]
            .contains(&link.kind.as_str())
            {
                link.kind = "other".into();
            }
        }
        Ok(Some(Article {
            id: row.try_get("id")?,
            source_article_id: row.try_get("source_article_id")?,
            url: row.try_get("url")?,
            title_parts: TitleParts {
                season: row.try_get("title_season")?,
                team: row.try_get("title_team")?,
                labels: strings(row.try_get("title_labels")?),
                topic: row
                    .try_get::<Option<String>, _>("title_topic")?
                    .unwrap_or_else(|| title.clone()),
            },
            title,
            author: row.try_get("author")?,
            published_at: optional_date(row.try_get("published_at")?),
            discovered_at: iso(row.try_get("discovered_at")?),
            fetched_at: optional_date(row.try_get("fetched_at")?),
            is_pinned: row.try_get("is_pinned")?,
            tags: strings(row.try_get("tags")?),
            excerpt: excerpt(introduction.as_deref(), body_head.as_deref()),
            introduction,
            body_chars: row.try_get("body_chars")?,
            link_count: row.try_get("link_count")?,
            image_count: row.try_get("image_count")?,
            tldr: row.try_get("tldr")?,
            content_format: content_format.filter(|v| v == "html" || v == "markdown"),
            content_html: row.try_get("content_html")?,
            body_text: row.try_get("body_text")?,
            links,
            images: serde_json::from_value(images).map_err(|e| sqlx::Error::Decode(Box::new(e)))?,
        }))
    }

    pub async fn content(
        &self,
        id: &str,
        format: ContentFormat,
    ) -> Result<Option<ArticleContent>, sqlx::Error> {
        let row = sqlx::query("SELECT content_format, content_raw, content_html, body_text FROM articles WHERE id = $1 AND status = 'fetched'")
            .bind(id).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let source_format: Option<String> = row.try_get("content_format")?;
        let raw: Option<String> = row.try_get("content_raw")?;
        let html: Option<String> = row.try_get("content_html")?;
        let text: Option<String> = row.try_get("body_text")?;
        let (format, body) = content_body(format, source_format.as_deref(), raw, html, text);
        Ok(Some(ArticleContent { format, body }))
    }

    pub async fn tags(&self) -> Result<TagIndex, sqlx::Error> {
        let row = sqlx::query(include_str!("sql/tags.sql"))
            .fetch_one(&self.pool)
            .await?;
        let mut index = TagIndex {
            items: serde_json::from_value(row.try_get("items")?)
                .map_err(|e| sqlx::Error::Decode(Box::new(e)))?,
            groups: serde_json::from_value(row.try_get("groups")?)
                .map_err(|e| sqlx::Error::Decode(Box::new(e)))?,
            total: row.try_get("total")?,
        };
        // Match JavaScript string comparison, independently of the database collation.
        for counts in [&mut index.items, &mut index.groups] {
            counts.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then_with(|| a.name.encode_utf16().cmp(b.name.encode_utf16()))
            });
        }
        Ok(index)
    }
}

pub(crate) fn strings(value: Value) -> Vec<String> {
    value
        .as_array()
        .map(|xs| {
            xs.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn optional_date(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(iso)
}

// JavaScript \s differs from Rust's is_whitespace (FEFF is included; U+0085 is not).
pub(crate) fn js_whitespace(ch: char) -> bool {
    ch == '\u{feff}' || (ch != '\u{85}' && ch.is_whitespace())
}
pub fn collapse(text: &str) -> String {
    text.split(js_whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn truncate(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

pub fn excerpt(introduction: Option<&str>, body_head: Option<&str>) -> Option<String> {
    if let Some(intro) = introduction
        .map(|s| s.trim_matches(js_whitespace))
        .filter(|s| !s.is_empty())
    {
        return Some(intro.into());
    }
    body_head
        .map(collapse)
        .filter(|s| !s.is_empty())
        .map(|s| truncate(&s, 200))
}

fn content_body(
    format: ContentFormat,
    source: Option<&str>,
    raw: Option<String>,
    html: Option<String>,
    text: Option<String>,
) -> (ContentFormat, String) {
    match (format, source, raw, html) {
        (ContentFormat::Markdown, Some("markdown"), Some(raw), _) => (ContentFormat::Markdown, raw),
        (ContentFormat::Html, _, _, Some(html)) => (ContentFormat::Html, html),
        _ => (ContentFormat::Text, text.unwrap_or_default()),
    }
}

/// The existing API accepts Crockford-shaped IDs case-insensitively, then uppercases them.
pub fn article_id(raw: &str) -> Option<String> {
    (raw.len() == 26
        && raw
            .bytes()
            .all(|ch| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&ch.to_ascii_uppercase())))
    .then(|| raw.to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_matches_the_existing_unicode_contract() {
        assert_eq!(
            excerpt(Some(" \u{feff} 简介 \n"), Some("body")),
            Some("简介".into())
        );
        assert_eq!(collapse("a\u{feff} b\u{85}c"), "a b\u{85}c");
        assert_eq!(truncate("🤖控制器", 2), "🤖控…");
        assert_eq!(excerpt(None, Some(" \n ")), None);
        assert_eq!(truncate("控制", 2), "控制");
    }
    #[test]
    fn markdown_on_html_falls_back_to_text() {
        assert_eq!(
            content_body(
                ContentFormat::Markdown,
                Some("html"),
                Some("<p>x</p>".into()),
                Some("<p>x</p>".into()),
                Some("x".into())
            ),
            (ContentFormat::Text, "x".into())
        );
        assert_eq!(
            content_body(ContentFormat::Html, None, None, None, None),
            (ContentFormat::Text, "".into())
        );
    }
    #[test]
    fn ids_match_the_existing_api() {
        assert_eq!(
            article_id("01j0000000000000000000000a"),
            Some("01J0000000000000000000000A".into())
        );
        for id in [
            "not-an-id",
            "01J0000000000000000000000I",
            "01J0000000000000000000000U",
        ] {
            assert!(article_id(id).is_none());
        }
    }
}
