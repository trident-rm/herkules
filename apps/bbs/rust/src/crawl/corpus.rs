//! Atomic corpus writes using the same tables and derivations as the Node writer.
use super::{
    Error, Result,
    source::{Detail, Listed},
    title,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row};
use std::collections::HashMap;
pub const SOURCE: &str = "robomaster";
pub const LOCK: i64 = 0x6262735f;
pub const MIN_BODY: usize = 100;
#[derive(Clone)]
pub struct Corpus {
    pub pool: PgPool,
}
#[derive(Debug, Clone)]
pub struct Article {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub pinned: bool,
}
#[derive(Debug, Clone)]
pub enum Work {
    Refresh(Article),
    Fetch(Article),
    Backfill(i32),
    Idle,
}
#[derive(Debug, Default, Serialize)]
pub struct Outcome {
    pub listed: i32,
    pub discovered: i32,
    pub fetched: i32,
    pub skipped: i32,
    pub failed: i32,
    pub refreshed: i32,
    pub error: Option<String>,
}
pub fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
pub fn id(now: DateTime<Utc>) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let n =
        ((now.timestamp_millis() as u128) << 80) | (rand::random::<u128>() & ((1_u128 << 80) - 1));
    (0..26)
        .rev()
        .map(|i| ALPHABET[((n >> (i * 5)) & 31) as usize] as char)
        .collect()
}
fn truncated(s: &str) -> String {
    s.chars().take(500).collect()
}
impl Corpus {
    pub async fn boot(&self) -> Result<()> {
        let now = Utc::now();
        sqlx::query("UPDATE poll_runs SET status='abandoned',finished_at=$1,error='interrupted: the process stopped before the run finished' WHERE status='running'").bind(now).execute(&self.pool).await?;
        sqlx::query("INSERT INTO sources(id,kind,name,site_url,created_at,updated_at) VALUES ('robomaster','robomaster','RoboMaster Developer Community','https://bbs.robomaster.com/article',$1,$1) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,site_url=excluded.site_url,updated_at=excluded.updated_at").bind(now).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn start(&self, trigger: &str) -> Result<String> {
        let now = Utc::now();
        let id = id(now);
        sqlx::query("INSERT INTO poll_runs(id,source_id,trigger,status,started_at) VALUES ($1,'robomaster',$2,'running',$3)").bind(&id).bind(trigger).bind(now).execute(&self.pool).await?;
        Ok(id)
    }
    pub async fn finish(&self, id: &str, o: &Outcome) -> Result<()> {
        sqlx::query("UPDATE poll_runs SET status=$2,finished_at=$3,listed=$4,discovered=$5,fetched=$6,skipped=$7,failed=$8,refreshed=$9,error=$10 WHERE id=$1").bind(id).bind(if o.error.is_some(){"failed"}else{"succeeded"}).bind(Utc::now()).bind(o.listed).bind(o.discovered).bind(o.fetched).bind(o.skipped).bind(o.failed).bind(o.refreshed).bind(o.error.as_deref()).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn checked(&self) -> Result<()> {
        sqlx::query("UPDATE sources SET last_checked_at=$1,initialized_at=coalesce(initialized_at,$1),updated_at=$1 WHERE id='robomaster'").bind(Utc::now()).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn discover(&self, listed: &[Listed]) -> Result<i32> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        let mut count = 0;
        for item in listed {
            let p = title::split(&item.title);
            let row=sqlx::query("INSERT INTO articles(id,source_id,source_article_id,canonical_url,url_hash,title,title_season,title_team,title_topic,title_labels,author,published_at,discovered_at,listing_position,is_pinned,introduction,status,created_at,updated_at) VALUES ($1,'robomaster',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$12,$12) ON CONFLICT(source_id,source_article_id) DO UPDATE SET listing_position=excluded.listing_position,is_pinned=excluded.is_pinned,introduction=coalesce(articles.introduction,excluded.introduction),updated_at=excluded.updated_at WHERE articles.listing_position<>excluded.listing_position OR articles.is_pinned<>excluded.is_pinned OR (articles.introduction IS NULL AND excluded.introduction IS NOT NULL) RETURNING id,(xmax=0) AS inserted")
                .bind(id(now)).bind(&item.source_article_id).bind(&item.url).bind(hash(&item.url)).bind(&item.title).bind(p.season).bind(p.team).bind(p.topic).bind(p.labels).bind(&item.author).bind(item.published_at).bind(now).bind(item.listing_position).bind(item.is_pinned).bind(&item.introduction).fetch_optional(&mut *tx).await?;
            if let Some(r) = row
                && r.get::<bool, _>("inserted")
            {
                count += 1;
                let id: String = r.get("id");
                for (position, tag) in item.tags.iter().enumerate() {
                    sqlx::query("INSERT INTO article_tags(article_id,tag,position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING").bind(&id).bind(tag).bind(position as i32).execute(&mut *tx).await?;
                }
            }
        }
        if count > 0 {
            let index = targets(&mut tx).await?;
            let links =
                sqlx::query("SELECT id,url FROM article_links WHERE target_article_id IS NULL")
                    .fetch_all(&mut *tx)
                    .await?;
            for row in links {
                let url: String = row.get("url");
                if let Some(target) = index.resolve(&url) {
                    sqlx::query("UPDATE article_links SET target_article_id=$2 WHERE id=$1")
                        .bind(row.get::<String, _>("id"))
                        .bind(target)
                        .execute(&mut *tx)
                        .await?;
                }
            }
        }
        tx.commit().await?;
        Ok(count)
    }
    pub async fn next(&self, refresh: bool, fetch: bool, backfill: bool) -> Result<Work> {
        let row=sqlx::query("SELECT * FROM ((SELECT 1 AS rank,id,source_article_id,title,is_pinned,NULL::int AS page FROM articles WHERE $1 AND source_id='robomaster' AND status='fetched' AND refresh_requested_at IS NOT NULL ORDER BY refresh_requested_at,id LIMIT 1) UNION ALL (SELECT 2 AS rank,id,source_article_id,title,is_pinned,NULL::int AS page FROM articles WHERE $2 AND source_id='robomaster' AND (status='pending' OR (status='failed' AND updated_at<$4)) ORDER BY coalesce(published_at,discovered_at) DESC,listing_position,id DESC LIMIT 1) UNION ALL (SELECT 3 AS rank,NULL::text,NULL::text,NULL::text,NULL::boolean,greatest(backfill_next_page,2) FROM sources WHERE $3 AND id='robomaster' AND backfill_completed_at IS NULL)) AS ladder ORDER BY rank LIMIT 1")
            .bind(refresh).bind(fetch).bind(backfill).bind(Utc::now()-chrono::Duration::hours(1)).fetch_optional(&self.pool).await?;
        let Some(r) = row else {
            return Ok(Work::Idle);
        };
        let rank: i32 = r.get("rank");
        if rank == 3 {
            return Ok(Work::Backfill(r.get("page")));
        }
        let a = Article {
            id: r.get("id"),
            source_id: r.get("source_article_id"),
            title: r.get("title"),
            pinned: r.get("is_pinned"),
        };
        Ok(if rank == 1 {
            Work::Refresh(a)
        } else {
            Work::Fetch(a)
        })
    }
    pub async fn advance(&self, next: i32, done: bool) -> Result<()> {
        let now = Utc::now();
        sqlx::query("UPDATE sources SET backfill_next_page=$1,backfill_completed_at=$2,updated_at=$3 WHERE id='robomaster'").bind(next).bind(done.then_some(now)).bind(now).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn skip(&self, id: &str, reason: &str) -> Result<()> {
        sqlx::query("UPDATE articles SET status='skipped',skip_reason=$2,last_error=NULL,updated_at=$3 WHERE id=$1").bind(id).bind(reason).bind(Utc::now()).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn failed(&self, id: &str, error: &str, refresh: bool) -> Result<()> {
        sqlx::query("UPDATE articles SET status=CASE WHEN $4 THEN status ELSE 'failed' END,refresh_requested_at=CASE WHEN $4 THEN NULL ELSE refresh_requested_at END,last_error=$2,updated_at=$3 WHERE id=$1").bind(id).bind(truncated(error)).bind(Utc::now()).bind(refresh).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn store(&self, id: &str, d: &Detail) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        let p = title::split(&d.listed.title);
        let prev =
            sqlx::query("SELECT content_hash,canonical_url FROM articles WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let base: String = prev.get("canonical_url");
        let hash = hash(&d.extracted.body_text);
        let changed = prev.get::<Option<String>, _>("content_hash").as_ref() != Some(&hash);
        let html = super::content::render_html(
            &d.format,
            &d.raw,
            &base,
            &d.listed.title,
            &d.extracted.links,
        );
        sqlx::query("UPDATE articles SET title=$2,title_season=$3,title_team=$4,title_topic=$5,title_labels=$6,author=coalesce($7,author),published_at=coalesce($8,published_at),introduction=coalesce($9,introduction),is_pinned=$10,content_format=$11,content_raw=$12,content_html=$13,body_text=$14,content_hash=$15,parser_version=$16,status='fetched',skip_reason=NULL,last_error=NULL,fetched_at=$17,updated_at=$17,refresh_requested_at=NULL,content_changed_at=CASE WHEN $18 THEN $17 ELSE coalesce(content_changed_at,$17) END WHERE id=$1")
            .bind(id).bind(&d.listed.title).bind(p.season).bind(p.team).bind(p.topic).bind(p.labels).bind(&d.listed.author).bind(d.listed.published_at).bind(&d.listed.introduction).bind(d.listed.is_pinned).bind(&d.format).bind(&d.raw).bind(html).bind(&d.extracted.body_text).bind(hash).bind(&d.parser_version).bind(now).bind(changed).execute(&mut *tx).await?;
        if !d.listed.tags.is_empty() {
            sqlx::query("DELETE FROM article_tags WHERE article_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            for (position, tag) in d.listed.tags.iter().enumerate() {
                sqlx::query("INSERT INTO article_tags(article_id,tag,position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(tag).bind(position as i32).execute(&mut *tx).await?;
            }
        }
        let tags: Vec<String> = sqlx::query_scalar(
            "SELECT tag FROM article_tags WHERE article_id=$1 ORDER BY position",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        let index = targets(&mut tx).await?;
        sqlx::query("DELETE FROM article_links WHERE article_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for link in &d.extracted.links {
            sqlx::query("INSERT INTO article_links(id,article_id,url,kind,label,position,target_article_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING").bind(self::id(now)).bind(id).bind(&link.url).bind(&link.kind).bind(&link.label).bind(link.position).bind(index.resolve(&link.url)).execute(&mut *tx).await?;
        }
        let urls: Vec<_> = d.extracted.images.iter().map(|i| i.url.clone()).collect();
        sqlx::query("DELETE FROM article_images WHERE article_id=$1 AND NOT(url=ANY($2))")
            .bind(id)
            .bind(urls)
            .execute(&mut *tx)
            .await?;
        for image in &d.extracted.images {
            sqlx::query("INSERT INTO article_images(id,article_id,url,alt,position) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(article_id,url) DO UPDATE SET alt=excluded.alt,position=excluded.position").bind(self::id(now)).bind(id).bind(&image.url).bind(&image.alt).bind(image.position).execute(&mut *tx).await?;
        }
        let author = d.listed.author.as_deref().unwrap_or("");
        let tags = tags.join(" ");
        let intro = d.listed.introduction.as_deref().unwrap_or("");
        let document = crate::feed::normalize(
            &[
                d.listed.title.as_str(),
                author,
                &tags,
                intro,
                &d.extracted.body_text,
            ]
            .join("\n"),
        );
        sqlx::query("INSERT INTO article_search(article_id,title,author,tags,introduction,body_text,document) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(article_id) DO UPDATE SET title=excluded.title,author=excluded.author,tags=excluded.tags,introduction=excluded.introduction,body_text=excluded.body_text,document=excluded.document").bind(id).bind(&d.listed.title).bind(author).bind(tags).bind(intro).bind(&d.extracted.body_text).bind(document).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(changed)
    }
}
struct Targets {
    canonical: HashMap<String, String>,
    source: HashMap<String, String>,
}
impl Targets {
    fn resolve(&self, url: &str) -> Option<&str> {
        self.canonical
            .get(url)
            .or_else(|| {
                static POST: std::sync::LazyLock<regex::Regex> =
                    std::sync::LazyLock::new(|| regex::Regex::new(r"/article/(\d+)").unwrap());
                let c = POST.captures(url)?;
                self.source.get(&c[1])
            })
            .map(String::as_str)
    }
}
async fn targets(c: &mut PgConnection) -> Result<Targets> {
    let rows = sqlx::query(
        "SELECT id,canonical_url,source_article_id FROM articles WHERE source_id='robomaster'",
    )
    .fetch_all(c)
    .await?;
    let mut index = Targets {
        canonical: HashMap::new(),
        source: HashMap::new(),
    };
    for r in rows {
        let id: String = r.get("id");
        index.canonical.insert(r.get("canonical_url"), id.clone());
        index.source.insert(r.get("source_article_id"), id);
    }
    Ok(index)
}
/// Own a dedicated physical connection. Close it rather than returning a locked session to a pool.
pub async fn lock(url: &str) -> Result<PgConnection> {
    use sqlx::Connection;
    let mut c = PgConnection::connect(url).await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(LOCK)
        .fetch_one(&mut c)
        .await?;
    if !locked {
        return Err(Error::LockHeld);
    }
    Ok(c)
}
