//! Ranked substring search over the existing folded trgm documents.
use crate::{
    feed::{self, ArticleSummary, FeedError, FeedQuery},
    library::{Library, article_id, js_whitespace},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use serde_json::json;
use sqlx::{Execute, Postgres, QueryBuilder, Row};

pub struct Term {
    pub raw: String,
    pub text: String,
    pub pattern: String,
}
pub fn terms(q: &str) -> Vec<Term> {
    let mut out: Vec<Term> = Vec::new();
    for raw in q
        .replace('"', " ")
        .split(js_whitespace)
        .filter(|s| !s.is_empty())
    {
        let text = feed::normalize(raw);
        if out.iter().any(|t| t.text == text) {
            continue;
        }
        let pattern = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        out.push(Term {
            raw: raw.into(),
            text,
            pattern,
        });
        if out.len() == 8 {
            break;
        }
    }
    out
}
pub struct SearchQuery {
    pub terms: Vec<Term>,
    pub scope: String,
    pub tag: Option<String>,
    pub group: Option<String>,
    pub limit: usize,
    pub cursor: Option<(f64, String)>,
}
#[derive(Debug)]
pub enum SearchError {
    Query(FeedError),
    Empty,
}
impl FeedQuery {
    pub fn validate_search(self) -> Result<SearchQuery, SearchError> {
        self.validate_search_with_bounds(true)
    }
    pub(crate) fn validate_search_with_bounds(
        mut self,
        bounded: bool,
    ) -> Result<SearchQuery, SearchError> {
        let q = self.q.clone().unwrap_or_default();
        if bounded && q.trim_matches(js_whitespace).is_empty() {
            return Err(SearchError::Query(FeedError::InvalidQuery));
        }
        if bounded
            && self
                .cursor
                .as_ref()
                .is_some_and(|s| s.encode_utf16().count() > 512)
        {
            return Err(SearchError::Query(FeedError::InvalidQuery));
        }
        let cursor = self.cursor.take();
        let valid = self
            .validate_with_bounds(bounded)
            .map_err(SearchError::Query)?;
        let terms = terms(&q);
        if terms.is_empty() {
            return Err(SearchError::Empty);
        }
        let cursor = cursor
            .filter(|s| !s.is_empty())
            .map(|raw| {
                let v = feed::cursor_value(&raw)?;
                let a = v.as_array()?;
                if a.first()?.as_str()? != "r" {
                    return None;
                }
                let score = a.get(1)?.as_f64()?;
                let id = a.get(2)?.as_str()?;
                article_id(id)?;
                score.is_finite().then(|| (score, id.into()))
            })
            .map(|key| key.ok_or(SearchError::Query(FeedError::InvalidCursor)))
            .transpose()?;
        Ok(SearchQuery {
            terms,
            scope: valid.scope,
            tag: valid.tag,
            group: valid.group,
            limit: valid.limit,
            cursor,
        })
    }
}
#[derive(Debug, Serialize)]
pub struct Segment {
    pub text: String,
    pub hit: bool,
}
#[derive(Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub article: ArticleSummary,
    pub score: f64,
    pub snippet: Option<Vec<Segment>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub next_cursor: Option<String>,
    pub terms: Vec<String>,
}
const ARTICLE: &[&str] = &["title", "author", "tags", "introduction", "body_text"];
const KB: &[&str] = &[
    "tldr",
    "problem",
    "approach",
    "components",
    "parameters",
    "decisions",
    "pitfalls",
    "entities",
    "keywords",
    "captions",
];
// Node uses Number.toPrecision(12) for ranking constants. Scientific notation
// with eleven fractional digits has the same twelve significant digits.
fn precision(n: f64) -> String {
    format!("{n:.11e}")
}
impl Library {
    pub async fn search(&self, q: SearchQuery) -> Result<SearchPage, sqlx::Error> {
        let table = if q.scope == "kb" {
            "kb_search"
        } else {
            "article_search"
        };
        let fields = if q.scope == "kb" {
            KB
        } else if q.scope == "title" {
            &ARTICLE[..1]
        } else {
            ARTICLE
        };
        let doc = if q.scope == "title" {
            "substr(s.document, 1, length(s.title))"
        } else {
            "s.document"
        };
        let mut stats = QueryBuilder::<Postgres>::new("SELECT count(*)::int AS documents");
        for (i, t) in q.terms.iter().enumerate() {
            stats
                .push(format!(", count(*) FILTER (WHERE {doc} LIKE "))
                .push_bind(&t.pattern)
                .push(format!(" ESCAPE '\\')::int AS df_{i}"));
        }
        for (i, f) in fields.iter().enumerate() {
            stats.push(format!(
                ", coalesce(avg(length(s.{f})),0)::double precision AS avg_{i}"
            ));
        }
        stats.push(format!(" FROM {table} s"));
        let stats = stats.build().fetch_one(self.pool()).await?;
        let n = f64::from(stats.try_get::<i32, _>("documents")?).max(1.0);
        let mut score = QueryBuilder::<Postgres>::new("coalesce(");
        for (ti, t) in q.terms.iter().enumerate() {
            let df = f64::from(stats.try_get::<i32, _>(format!("df_{ti}").as_str())?);
            let idf = precision((1.0 + (n - df + 0.5) / (df + 0.5)).ln());
            for (i, f) in fields.iter().enumerate() {
                if ti > 0 || i > 0 {
                    score.push(" + ");
                }
                let start = std::iter::once("1".to_owned())
                    .chain(fields[..i].iter().map(|f| format!("length(s.{f}) + 1")))
                    .collect::<Vec<_>>()
                    .join(" + ");
                let slice = format!("substr({doc}, {start}, length(s.{f}))");
                let avg = precision(
                    stats
                        .try_get::<f64, _>(format!("avg_{i}").as_str())?
                        .max(1.0),
                );
                // Build once as a CTE, then filter on its score alias. All text is bound.
                score
                    .push(format!(
                        "({idf} * ((length({slice}) - length(replace({slice}, "
                    ))
                    .push_bind(&t.text)
                    .push("::text, '')))::double precision / length(")
                    .push_bind(&t.text)
                    .push(format!(
                        "::text)) * 2.2 / nullif(((length({slice}) - length(replace({slice}, "
                    ))
                    .push_bind(&t.text)
                    .push("::text, '')))::double precision / length(")
                    .push_bind(&t.text)
                    .push(format!(
                        "::text)) + (1.2 * (1 - 0.75 + 0.75 * length(s.{f}) / {avg})), 0))"
                    ));
            }
        }
        score.push(",0)::double precision");
        // Keep score parameters first when wrapping its expression in the full
        // statement, then append all remaining bindings to the same builder.
        let expression = score.sql().to_owned();
        let projection = include_str!("sql/feed.sql")
            .split("\nFROM articles")
            .next()
            .unwrap()
            .replacen("SELECT ", "", 1);
        let snippet_fields = if q.scope == "kb" {
            KB
        } else {
            &["body_text", "introduction", "title"]
        };
        let snippets = snippet_fields
            .iter()
            .enumerate()
            .map(|(i, f)| format!("s.{f} AS snip_{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let prefix = format!(
            "WITH ranked AS (SELECT {projection}, {expression} AS score, {snippets} FROM articles JOIN {table} s ON s.article_id = articles.id LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready' WHERE articles.status = 'fetched'"
        );
        let args = score
            .build()
            .take_arguments()
            .expect("query arguments")
            .expect("arguments present");
        let mut sql = QueryBuilder::<Postgres>::with_arguments(prefix, args);
        for t in &q.terms {
            sql.push(format!(" AND {doc} LIKE "))
                .push_bind(&t.pattern)
                .push(" ESCAPE '\\'");
        }
        for (v, c) in [(&q.tag, "tag"), (&q.group, "group_name")] {
            if let Some(v) = v {
                sql.push(format!(" AND EXISTS (SELECT 1 FROM article_tags WHERE article_id = articles.id AND {c} = ")).push_bind(v).push(")");
            }
        }
        sql.push(") SELECT * FROM ranked WHERE true");
        if let Some((score, id)) = &q.cursor {
            sql.push(" AND (score < ")
                .push_bind(score)
                .push("::double precision OR (score = ")
                .push_bind(score)
                .push("::double precision AND id < ")
                .push_bind(id)
                .push("))");
        }
        sql.push(" ORDER BY score DESC, id DESC LIMIT ")
            .push_bind((q.limit + 1) as i64);
        let mut rows = sql.build().fetch_all(self.pool()).await?;
        let more = rows.len() > q.limit;
        rows.truncate(q.limit);
        let next_cursor = if more {
            rows.last()
                .map(|r| {
                    Ok::<_, sqlx::Error>(
                        URL_SAFE_NO_PAD.encode(
                            serde_json::to_vec(&json!([
                                "r",
                                r.try_get::<f64, _>("score")?,
                                r.try_get::<String, _>("id")?
                            ]))
                            .unwrap(),
                        ),
                    )
                })
                .transpose()?
        } else {
            None
        };
        let items = rows
            .iter()
            .map(|r| {
                let fields = (0..snippet_fields.len())
                    .map(|i| {
                        r.try_get::<Option<String>, _>(format!("snip_{i}").as_str())
                            .map(|s| s.unwrap_or_default())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(SearchHit {
                    article: feed::summary(r)?,
                    score: r.try_get("score")?,
                    snippet: snippet(&fields, &q.terms),
                })
            })
            .collect::<Result<_, sqlx::Error>>()?;
        Ok(SearchPage {
            items,
            next_cursor,
            terms: q.terms.into_iter().map(|t| t.raw).collect(),
        })
    }
}
#[derive(Clone)]
struct Hit {
    start: usize,
    end: usize,
    term: usize,
}
pub fn snippet(fields: &[String], terms: &[Term]) -> Option<Vec<Segment>> {
    let mut best = None;
    let mut coverage = 0;
    for field in fields {
        let folded: Vec<u16> = feed::normalize(field).encode_utf16().collect();
        let mut hits = Vec::new();
        let mut order: Vec<usize> = (0..terms.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(terms[i].text.encode_utf16().count()));
        for term in order {
            let text: Vec<u16> = terms[term].text.encode_utf16().collect();
            for (start, _) in folded
                .windows(text.len())
                .enumerate()
                .filter(|(_, w)| *w == text.as_slice())
                .take(50)
            {
                hits.push(Hit {
                    start,
                    end: start + text.len(),
                    term,
                });
            }
        }
        hits.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
        for h in &hits {
            let mut seen = std::collections::HashSet::new();
            for o in &hits {
                if o.start as isize >= h.start as isize - 60 && o.end <= h.start + 60 {
                    seen.insert(o.term);
                }
            }
            if best.is_none() || seen.len() > coverage {
                coverage = seen.len();
                best = Some((field, hits.clone(), h.start));
            }
        }
    }
    let (field, hits, center) = best?;
    let raw: Vec<u16> = field.encode_utf16().collect();
    let mut start = center.saturating_sub(60);
    let mut end = (center + 60).min(raw.len());
    if start > 0
        && raw
            .get(start)
            .is_some_and(|c| (0xdc00..=0xdfff).contains(c))
    {
        start -= 1;
    }
    if end < raw.len() && (0xdc00..=0xdfff).contains(&raw[end]) {
        end += 1;
    }
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for h in hits {
        if h.end <= start || h.start >= end {
            continue;
        }
        let s = h.start.max(start);
        let e = h.end.min(end);
        if let Some(last) = spans.last_mut().filter(|last| s <= last.1) {
            last.1 = last.1.max(e);
        } else {
            spans.push((s, e));
        }
    }
    let mut out: Vec<Segment> = Vec::new();
    let mut push = |text: String, hit| {
        if text.is_empty() {
            return;
        }
        if let Some(last) = out.last_mut().filter(|last| last.hit == hit) {
            last.text.push_str(&text);
        } else {
            out.push(Segment { text, hit });
        }
    };
    let collapse = |units: &[u16]| {
        let mut out = String::new();
        let mut space = false;
        for c in String::from_utf16_lossy(units).chars() {
            if js_whitespace(c) {
                if !space {
                    out.push(' ');
                }
                space = true;
            } else {
                out.push(c);
                space = false;
            }
        }
        out
    };
    if start > 0 {
        push("…".into(), false);
    }
    let mut at = start;
    for (s, e) in spans {
        push(collapse(&raw[at..s]), false);
        push(String::from_utf16_lossy(&raw[s..e]), true);
        at = e;
    }
    push(collapse(&raw[at..end]), false);
    if end < raw.len() {
        push("…".into(), false);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snippets_choose_distinct_coverage_and_keep_original_case() {
        let fields = vec!["PID PID PID".into(), "机器机器人 ＰＩＤ\t[1]".into()];
        let result = snippet(&fields, &terms("机器 机器人 pid")).unwrap();
        assert_eq!(
            result.iter().map(|s| s.text.as_str()).collect::<String>(),
            "机器机器人 ＰＩＤ [1]"
        );
        assert_eq!(
            result
                .iter()
                .filter(|s| s.hit)
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            vec!["机器机器人", "ＰＩＤ"]
        );
    }
    #[test]
    fn snippet_window_never_splits_an_emoji() {
        let field = "🤖".repeat(31) + "PID" + &"🤖".repeat(40);
        let result = snippet(&[field], &terms("pid")).unwrap();
        assert!(result.first().unwrap().text.starts_with('…'));
        assert!(result.last().unwrap().text.ends_with('…'));
        assert!(!result.iter().any(|s| s.text.contains('�')));
        assert_eq!(
            result
                .iter()
                .filter(|s| s.hit)
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            vec!["PID"]
        );
    }
}
