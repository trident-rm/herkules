//! Corpus status and lightweight metadata reads.
use crate::library::{Library, excerpt, iso};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::Row;
impl Library {
    pub async fn status(&self) -> Result<Value, sqlx::Error> {
        let r = sqlx::query(include_str!("sql/status.sql"))
            .fetch_one(self.pool())
            .await?;
        let n = |key: &str| r.try_get::<i32, _>(key);
        let date = |key: &str| -> Result<Option<String>, sqlx::Error> {
            Ok(r.try_get::<Option<DateTime<Utc>>, _>(key)?.map(iso))
        };
        let last = r.try_get::<Option<DateTime<Utc>>, _>("last_checked_at")?;
        let age = last.map(|d| {
            ((Utc::now().timestamp_millis() - d.timestamp_millis()) as f64 / 1000.0)
                .round()
                .max(0.0) as i64
        });
        Ok(
            json!({"site":{"name":r.try_get::<Option<String>,_>("site_name")?.unwrap_or_else(|| "RM 论坛".into()),"url":r.try_get::<Option<String>,_>("site_url")?.unwrap_or_default()},"articles":{"total":n("total")?,"fetched":n("fetched")?,"skipped":n("skipped")?,"tags":n("tags")?,"images":n("images")?,"links":n("links")?},"ai":{"ready":n("ai_ready")?,"missing":n("ai_missing")?,"entities":n("entities")?},"crawler":{"lastCheckedAt":last.map(iso),"lastCheckedAgeSeconds":age,"backfillCompletedAt":date("backfill_completed_at")?},"importedAt":date("imported_at")?}),
        )
    }
    pub async fn head(&self, id: &str) -> Result<Option<Value>, sqlx::Error> {
        let r=sqlx::query("SELECT title,introduction,substr(body_text,1,300) AS body_head,author,published_at,(SELECT url FROM article_images WHERE article_id=articles.id ORDER BY position LIMIT 1) AS image FROM articles WHERE id=$1 AND status='fetched'").bind(id).fetch_optional(self.pool()).await?;
        let Some(r) = r else {
            return Ok(None);
        };
        let title = r.try_get::<String, _>("title")?;
        let intro = r.try_get::<Option<String>, _>("introduction")?;
        let body = r.try_get::<Option<String>, _>("body_head")?;
        Ok(Some(
            json!({"description":excerpt(intro.as_deref(),body.as_deref()).unwrap_or_else(|| title.clone()),"title":title,"path":format!("/articles/{id}"),"type":"article","image":r.try_get::<Option<String>,_>("image")?,"publishedAt":r.try_get::<Option<DateTime<Utc>>,_>("published_at")?.map(iso),"author":r.try_get::<Option<String>,_>("author")?}),
        ))
    }
    pub async fn entity_head(&self, key: &str) -> Result<Option<Value>, sqlx::Error> {
        let r = sqlx::query(
            "SELECT name,article_count FROM kb_entities WHERE key=$1 AND article_count>0 LIMIT 1",
        )
        .bind(key)
        .fetch_optional(self.pool())
        .await?;
        let Some(r) = r else {
            return Ok(None);
        };
        let name = r.try_get::<String, _>("name")?;
        // encodeURIComponent leaves these ASCII punctuation characters unescaped.
        let encoded: String = name
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        Ok(Some(
            json!({"description":format!("{}：{} 篇相关文章",name,r.try_get::<i32,_>("article_count")?),"title":name,"path":format!("/kb/{encoded}"),"type":"website","image":null,"publishedAt":null,"author":null}),
        ))
    }
}
