//! Date-ordered feed. One bounded query; cursor and substring semantics match Node.
use base64::{
    Engine, alphabet,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::URL_SAFE_NO_PAD,
    },
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row, postgres::PgRow};

use crate::library::{Library, TitleParts, article_id, excerpt, iso, js_whitespace};

#[derive(Debug, Default, Deserialize)]
pub struct FeedQuery {
    pub q: Option<String>,
    pub scope: Option<String>,
    pub tag: Option<String>,
    pub group: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FeedKey {
    pub at: DateTime<Utc>,
    pub position: i64,
    pub id: String,
}

pub struct ValidFeedQuery {
    pub patterns: Vec<String>,
    pub scope: String,
    pub tag: Option<String>,
    pub group: Option<String>,
    pub cursor: Option<FeedKey>,
    pub limit: usize,
}

#[derive(Debug, PartialEq)]
pub enum FeedError {
    InvalidQuery,
    InvalidCursor,
}

impl FeedQuery {
    pub fn validate(self) -> Result<ValidFeedQuery, FeedError> {
        self.validate_with_bounds(true)
    }
    pub(crate) fn validate_with_bounds(self, bounded: bool) -> Result<ValidFeedQuery, FeedError> {
        let q = self.q.unwrap_or_default();
        let q = q.trim_matches(js_whitespace);
        let scope = self.scope.unwrap_or_else(|| "all".into());
        if !["all", "title", "kb"].contains(&scope.as_str())
            || (bounded
                && (q.encode_utf16().count() > 200
                    || self
                        .tag
                        .as_ref()
                        .is_some_and(|s| s.encode_utf16().count() > 120)
                    || self
                        .group
                        .as_ref()
                        .is_some_and(|s| s.encode_utf16().count() > 120)
                    || self
                        .cursor
                        .as_ref()
                        .is_some_and(|s| s.encode_utf16().count() > 512)))
        {
            return Err(FeedError::InvalidQuery);
        }
        let limit = parse_limit(self.limit.as_deref(), 20, 100)?;
        let cursor = self
            .cursor
            .filter(|s| !s.is_empty())
            .map(|raw| decode_cursor(&raw).ok_or(FeedError::InvalidCursor))
            .transpose()?;
        Ok(ValidFeedQuery {
            patterns: terms(q),
            scope,
            tag: self.tag.filter(|s| !s.is_empty()),
            group: self.group.filter(|s| !s.is_empty()),
            cursor,
            limit,
        })
    }
}

pub(crate) fn parse_limit(
    raw: Option<&str>,
    fallback: usize,
    max: usize,
) -> Result<usize, FeedError> {
    Ok(match raw {
        None => fallback,
        Some(raw) => {
            let raw = raw.trim_matches(js_whitespace);
            let n = if raw.is_empty() {
                0.0
            } else {
                if let Some((digits, radix)) = raw
                    .strip_prefix("0x")
                    .or_else(|| raw.strip_prefix("0X"))
                    .map(|s| (s, 16))
                    .or_else(|| {
                        raw.strip_prefix("0b")
                            .or_else(|| raw.strip_prefix("0B"))
                            .map(|s| (s, 2))
                    })
                    .or_else(|| {
                        raw.strip_prefix("0o")
                            .or_else(|| raw.strip_prefix("0O"))
                            .map(|s| (s, 8))
                    })
                {
                    u64::from_str_radix(digits, radix).map_err(|_| FeedError::InvalidQuery)? as f64
                } else {
                    raw.parse::<f64>().map_err(|_| FeedError::InvalidQuery)?
                }
            };
            if !n.is_finite() || !(0.0..=9_007_199_254_740_991.0).contains(&n) || n.fract() != 0.0 {
                return Err(FeedError::InvalidQuery);
            }
            if n == 0.0 {
                fallback
            } else {
                n.min(max as f64) as usize
            }
        }
    })
}

pub fn encode_cursor(key: &FeedKey) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!(["f", iso(key.at), key.position, key.id]))
            .expect("serializable cursor"),
    )
}

pub fn decode_cursor(raw: &str) -> Option<FeedKey> {
    let tuple = cursor_value(raw)?;
    let fields = tuple.as_array()?;
    if fields.first()?.as_str()? != "f" {
        return None;
    }
    let raw_at = fields.get(1)?.as_str()?;
    let at = DateTime::parse_from_rfc3339(raw_at)
        .ok()?
        .with_timezone(&Utc);
    let position = fields.get(2)?.as_f64()?;
    if !position.is_finite()
        || position.fract() != 0.0
        || position < i64::MIN as f64
        || position >= i64::MAX as f64
    {
        return None;
    }
    let id = fields.get(3)?.as_str()?;
    article_id(id)?;
    Some(FeedKey {
        at,
        position: position as i64,
        id: id.into(),
    })
}

pub(crate) fn cursor_value(raw: &str) -> Option<Value> {
    // Buffer.from(base64url) accepts either alphabet, padding and stray non-alphabet bytes.
    let clean: String = raw
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    serde_json::from_slice(&decoder.decode(clean).ok()?).ok()
}

/// Fold BMP code units only, retaining expansions and supplementary letters exactly as JS does.
pub(crate) fn normalize(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            let ch = match ch as u32 {
                0xff01..=0xff5e => char::from_u32(ch as u32 - 0xfee0).unwrap(),
                0x3000 => ' ',
                _ => ch,
            };
            if ch.len_utf16() != 1 {
                return ch.to_string();
            }
            let lower: String = ch.to_lowercase().collect();
            if lower.encode_utf16().count() == 1 {
                lower
            } else {
                ch.to_string()
            }
        })
        .collect()
}

pub fn terms(raw: &str) -> Vec<String> {
    let stripped = raw.replace('"', " ");
    let mut seen = Vec::new();
    for raw in stripped.split(js_whitespace).filter(|s| !s.is_empty()) {
        let text = normalize(raw);
        if seen.contains(&text) {
            continue;
        }
        seen.push(text);
        if seen.len() == 8 {
            break;
        }
    }
    seen.into_iter()
        .map(|s| {
            format!(
                "%{}%",
                s.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleSummary {
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
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPage {
    pub items: Vec<ArticleSummary>,
    pub next_cursor: Option<String>,
}

impl Library {
    pub async fn feed(&self, query: ValidFeedQuery) -> Result<FeedPage, sqlx::Error> {
        let mut sql = QueryBuilder::<Postgres>::new(include_str!("sql/feed.sql"));
        for (value, column) in [(&query.tag, "tag"), (&query.group, "group_name")] {
            if let Some(value) = value {
                sql.push(
                    " AND EXISTS (SELECT 1 FROM article_tags WHERE article_id = articles.id AND ",
                )
                .push(column)
                .push(" = ")
                .push_bind(value)
                .push(")");
            }
        }
        if !query.patterns.is_empty() {
            let table = if query.scope == "kb" {
                "kb_search"
            } else {
                "article_search"
            };
            sql.push(" AND EXISTS (SELECT 1 FROM ")
                .push(table)
                .push(" WHERE article_id = articles.id");
            for pattern in &query.patterns {
                sql.push(" AND ");
                if query.scope == "title" {
                    sql.push("substr(document, 1, length(title))");
                } else {
                    sql.push("document");
                }
                sql.push(" LIKE ").push_bind(pattern).push(" ESCAPE '\\'");
            }
            sql.push(")");
        }
        if let Some(key) = &query.cursor {
            sql.push(" AND (coalesce(articles.published_at, articles.discovered_at) < ")
                .push_bind(key.at)
                .push(" OR (coalesce(articles.published_at, articles.discovered_at) = ")
                .push_bind(key.at)
                .push(" AND (listing_position > ")
                .push_bind(key.position)
                .push(" OR (listing_position = ")
                .push_bind(key.position)
                .push(" AND articles.id < ")
                .push_bind(&key.id)
                .push("))))");
        }
        sql.push(" ORDER BY coalesce(articles.published_at, articles.discovered_at) DESC, listing_position ASC, articles.id DESC LIMIT ").push_bind((query.limit + 1) as i64);
        let mut rows = sql.build().fetch_all(self.pool()).await?;
        let more = rows.len() > query.limit;
        rows.truncate(query.limit);
        let next_cursor = if more {
            rows.last()
                .map(|row| {
                    Ok::<_, sqlx::Error>(encode_cursor(&FeedKey {
                        at: row.try_get("feed_at")?,
                        position: i64::from(row.try_get::<i32, _>("listing_position")?),
                        id: row.try_get("id")?,
                    }))
                })
                .transpose()?
        } else {
            None
        };
        Ok(FeedPage {
            items: rows.iter().map(summary).collect::<Result<_, _>>()?,
            next_cursor,
        })
    }
}

pub(crate) fn summary(row: &PgRow) -> Result<ArticleSummary, sqlx::Error> {
    let introduction: Option<String> = row.try_get("introduction")?;
    let body_head: Option<String> = row.try_get("body_head")?;
    let title: String = row.try_get("title")?;
    Ok(ArticleSummary {
        id: row.try_get("id")?,
        source_article_id: row.try_get("source_article_id")?,
        url: row.try_get("url")?,
        title_parts: TitleParts {
            season: row.try_get("title_season")?,
            team: row.try_get("title_team")?,
            labels: crate::library::strings(row.try_get("title_labels")?),
            topic: row
                .try_get::<Option<String>, _>("title_topic")?
                .unwrap_or_else(|| title.clone()),
        },
        title,
        author: row.try_get("author")?,
        published_at: row
            .try_get::<Option<DateTime<Utc>>, _>("published_at")?
            .map(iso),
        discovered_at: iso(row.try_get("discovered_at")?),
        fetched_at: row
            .try_get::<Option<DateTime<Utc>>, _>("fetched_at")?
            .map(iso),
        is_pinned: row.try_get("is_pinned")?,
        tags: crate::library::strings(row.try_get("tags")?),
        excerpt: excerpt(introduction.as_deref(), body_head.as_deref()),
        introduction,
        body_chars: row.try_get("body_chars")?,
        link_count: row.try_get("link_count")?,
        image_count: row.try_get("image_count")?,
        tldr: row.try_get("tldr")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn term_folding_and_literal_like_match_javascript() {
        assert_eq!(
            terms("\"ＰＩＤ\" pid 步兵 100% a_b C:\\bin İ 𐐀"),
            vec![
                "%pid%",
                "%步兵%",
                "%100\\%%",
                "%a\\_b%",
                "%c:\\\\bin%",
                "%İ%",
                "%𐐀%"
            ]
        );
        assert_eq!(terms("a b c d e f g h i").len(), 8);
        assert!(terms("\" \u{feff}").is_empty());
    }
    #[test]
    fn cursors_reject_wrong_kind_and_round_trip() {
        let key = FeedKey {
            at: "2026-01-01T08:00:00.123Z".parse().unwrap(),
            position: -2,
            id: "01J0000000000000000000000A".into(),
        };
        let raw = encode_cursor(&key);
        assert_eq!(decode_cursor(&raw).unwrap().at, key.at);
        assert_eq!(decode_cursor(&format!("{raw}==")).unwrap().position, -2);
        for raw in ["bad", "", "WyJyIiwxLCIwMUowMDAwMDAwMDAwMDAwMDAwMDAwMEEiXQ"] {
            assert!(decode_cursor(raw).is_none());
        }
    }
    #[test]
    fn limits_are_defaulted_capped_and_validated() {
        for (raw, expected) in [
            (None, 20),
            (Some("0"), 20),
            (Some("1000"), 100),
            (Some("2e1"), 20),
        ] {
            assert_eq!(
                FeedQuery {
                    limit: raw.map(str::to_owned),
                    ..Default::default()
                }
                .validate()
                .unwrap()
                .limit,
                expected
            );
        }
        for raw in ["-1", "0.5", "NaN", "Infinity"] {
            assert!(
                FeedQuery {
                    limit: Some(raw.into()),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
    }
}
