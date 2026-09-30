//! Knowledge-base cards, cross-filtered facets and entity reads.
use crate::{
    ai::parse_kb,
    feed::{FeedError, parse_limit, terms},
    library::{Library, iso, js_whitespace, strings},
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row, postgres::PgRow};

#[derive(Default, Deserialize)]
pub struct KbQuery {
    pub q: Option<String>,
    pub domain: Option<String>,
    pub robot: Option<String>,
    pub genre: Option<String>,
    pub limit: Option<String>,
}
pub struct ValidKb {
    patterns: Vec<String>,
    domain: Option<String>,
    robot: Option<String>,
    genre: Option<String>,
    limit: usize,
}
impl KbQuery {
    pub fn validate(self) -> Result<ValidKb, FeedError> {
        let q = self.q.unwrap_or_default();
        let q = q.trim_matches(js_whitespace);
        if q.encode_utf16().count() > 200
            || [&self.domain, &self.robot, &self.genre]
                .iter()
                .any(|s| s.as_ref().is_some_and(|s| s.encode_utf16().count() > 64))
        {
            return Err(FeedError::InvalidQuery);
        }
        Ok(ValidKb {
            patterns: terms(q),
            domain: self.domain.filter(|s| !s.is_empty()),
            robot: self.robot.filter(|s| !s.is_empty()),
            genre: self.genre.filter(|s| !s.is_empty()),
            limit: parse_limit(self.limit.as_deref(), 200, 1000)?,
        })
    }
}
#[derive(Default, Deserialize)]
pub struct EntityQuery {
    pub q: Option<String>,
    pub limit: Option<String>,
}
impl EntityQuery {
    pub fn validate(self) -> Result<(Option<String>, usize), FeedError> {
        let q = self
            .q
            .map(|q| q.trim_matches(js_whitespace).to_owned())
            .filter(|s| !s.is_empty());
        if q.as_ref().is_some_and(|s| s.encode_utf16().count() > 120) {
            return Err(FeedError::InvalidQuery);
        }
        Ok((q, parse_limit(self.limit.as_deref(), 200, 500)?))
    }
}
fn array(key: &str) -> String {
    format!(
        "(CASE WHEN jsonb_typeof(article_ai.kb_json -> '{key}') = 'array' THEN article_ai.kb_json -> '{key}' ELSE '[]'::jsonb END)"
    )
}
const FROM: &str = " FROM article_ai JOIN articles ON articles.id = article_ai.article_id";
fn filters(sql: &mut QueryBuilder<'_, Postgres>, q: &ValidKb, skip: &str) {
    sql.push(" WHERE article_ai.status = 'ready' AND articles.status = 'fetched'");
    for (axis, key, value) in [
        ("domain", "domain", &q.domain),
        ("robot", "robotTypes", &q.robot),
    ] {
        if axis != skip
            && let Some(value) = value
        {
            sql.push(format!(" AND jsonb_exists({}, ", array(key)))
                .push_bind(value.clone())
                .push(")");
        }
    }
    if skip != "genre"
        && let Some(value) = &q.genre
    {
        sql.push(" AND article_ai.overview_json ->> 'genre' = ")
            .push_bind(value.clone());
    }
    if !q.patterns.is_empty() {
        sql.push(" AND EXISTS (SELECT 1 FROM kb_search WHERE article_id = articles.id");
        for p in &q.patterns {
            sql.push(" AND document LIKE ")
                .push_bind(p.clone())
                .push(" ESCAPE '\\'");
        }
        sql.push(")");
    }
}
fn date(row: &PgRow, key: &str) -> Result<Option<String>, sqlx::Error> {
    Ok(row.try_get::<Option<DateTime<Utc>>, _>(key)?.map(iso))
}
fn count(row: &PgRow) -> Result<Value, sqlx::Error> {
    Ok(
        json!({"key":row.try_get::<String,_>("key")?,"name":row.try_get::<String,_>("name")?,"articleCount":row.try_get::<i32,_>("article_count")?}),
    )
}
pub fn entity_key(raw: &str) -> String {
    // Match JS Unicode Letter/Number categories rather than Rust's broader
    // is_alphanumeric (which includes some combining marks).
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}]").unwrap());
    RE.replace_all(raw, "").to_lowercase()
}
impl Library {
    pub async fn kb_browse(&self, q: ValidKb) -> Result<Value, sqlx::Error> {
        let mut sql = QueryBuilder::<Postgres>::new(format!(
            "SELECT article_ai.article_id, articles.title, articles.author, articles.published_at, coalesce(article_ai.overview_json ->> 'tldr','') AS tldr, coalesce(article_ai.overview_json ->> 'genre','') AS genre, coalesce(article_ai.overview_json #>> '{{maturity,status}}','') AS maturity, article_ai.kb_json ->> 'problem' AS problem, {} AS domain, {} AS robot_types, {} AS entities, {} AS pitfalls, count(*) OVER ()::int AS total",
            array("domain"),
            array("robotTypes"),
            array("entities"),
            array("pitfalls")
        ));
        sql.push(FROM);
        filters(&mut sql, &q, "");
        sql.push(" ORDER BY coalesce(articles.published_at,articles.discovered_at) DESC, articles.id DESC LIMIT ").push_bind(q.limit as i64);
        let rows = sql.build().fetch_all(self.pool()).await?;
        let total = rows
            .first()
            .map(|r| r.try_get::<i32, _>("total"))
            .transpose()?
            .unwrap_or(0);
        let cards=rows.iter().map(|r| Ok::<_,sqlx::Error>(json!({"articleId":r.try_get::<String,_>("article_id")?,"title":r.try_get::<String,_>("title")?,"author":r.try_get::<Option<String>,_>("author")?,"publishedAt":date(r,"published_at")?,"tldr":r.try_get::<String,_>("tldr")?,"genre":r.try_get::<String,_>("genre")?,"maturity":r.try_get::<String,_>("maturity")?,"problem":r.try_get::<Option<String>,_>("problem")?,"domain":strings(r.try_get("domain")?),"robotTypes":strings(r.try_get("robot_types")?),"entities":strings(r.try_get("entities")?),"pitfalls":strings(r.try_get("pitfalls")?)}))).collect::<Result<Vec<_>,_>>()?;
        let mut sql = QueryBuilder::<Postgres>::new("");
        for (i, (axis, key)) in [("domain", "domain"), ("robot", "robotTypes"), ("genre", "")]
            .iter()
            .enumerate()
        {
            if i > 0 {
                sql.push(" UNION ALL ");
            }
            if *axis == "genre" {
                sql.push("SELECT 'genre' AS axis, article_ai.overview_json ->> 'genre' AS name, count(*)::int AS count").push(FROM);
                filters(&mut sql, &q, axis);
                sql.push(" AND coalesce(article_ai.overview_json ->> 'genre','') <> '' GROUP BY article_ai.overview_json ->> 'genre'");
            } else {
                sql.push(format!("SELECT '{axis}' AS axis, v AS name, count(*)::int AS count{FROM}, jsonb_array_elements_text({}) v",array(key)));
                filters(&mut sql, &q, axis);
                sql.push(" GROUP BY v");
            }
        }
        let facets = sql.build().fetch_all(self.pool()).await?;
        let pick = |axis: &str| -> Result<Vec<Value>, sqlx::Error> {
            let mut rows = Vec::new();
            for r in &facets {
                if r.try_get::<String, _>("axis")? == axis {
                    rows.push((
                        r.try_get::<Option<String>, _>("name")?
                            .unwrap_or_else(|| "null".into()),
                        r.try_get::<i32, _>("count")?,
                    ));
                }
            }
            rows.sort_by(|a, b| {
                b.1.cmp(&a.1)
                    .then_with(|| a.0.encode_utf16().cmp(b.0.encode_utf16()))
            });
            Ok(rows
                .into_iter()
                .map(|(name, count)| json!({"name":name,"count":count}))
                .collect())
        };
        Ok(
            json!({"total":total,"cards":cards,"domains":pick("domain")?,"robotTypes":pick("robot")?,"genres":pick("genre")?}),
        )
    }
    pub async fn entities(&self, q: Option<String>, limit: usize) -> Result<Value, sqlx::Error> {
        let mut sql = QueryBuilder::<Postgres>::new(
            "SELECT key,name,article_count FROM kb_entities WHERE article_count > 0",
        );
        if let Some(q) = q {
            let pattern = format!(
                "%{}%",
                q.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            sql.push(" AND name ILIKE ")
                .push_bind(pattern)
                .push(" ESCAPE '\\'");
        }
        sql.push(" ORDER BY article_count DESC,name ASC LIMIT ")
            .push_bind(limit as i64);
        let rows = sql.build().fetch_all(self.pool()).await?;
        Ok(json!({"items":rows.iter().map(count).collect::<Result<Vec<_>,_>>()?}))
    }
    pub async fn entity(&self, key: &str) -> Result<Option<Value>, sqlx::Error> {
        let rows=sqlx::query("SELECT e.key,e.name,e.article_count,articles.id,articles.title,articles.author,articles.published_at,coalesce(ai.overview_json ->> 'tldr','') AS tldr,ai.kb_json AS kb FROM kb_entities e LEFT JOIN article_entities ae ON ae.entity_key=e.key LEFT JOIN articles ON articles.id=ae.article_id AND articles.status='fetched' LEFT JOIN article_ai ai ON ai.article_id=articles.id AND ai.status='ready' WHERE e.key=$1 ORDER BY coalesce(articles.published_at,articles.discovered_at) DESC NULLS LAST,articles.id DESC").bind(key).fetch_all(self.pool()).await?;
        let Some(head) = rows.first() else {
            return Ok(None);
        };
        let mut articles = Vec::new();
        for r in &rows {
            if let Some(id) = r.try_get::<Option<String>, _>("id")? {
                let kb = r.try_get::<Option<Value>, _>("kb")?.unwrap_or(Value::Null);
                articles.push(json!({"articleId":id,"title":r.try_get::<String,_>("title")?,"author":r.try_get::<Option<String>,_>("author")?,"publishedAt":date(r,"published_at")?,"tldr":r.try_get::<String,_>("tldr")?,"kb":parse_kb(&kb).unwrap_or_else(|| parse_kb(&json!({})).unwrap())}));
            }
        }
        Ok(Some(json!({"entity":count(head)?,"articles":articles})))
    }
}
