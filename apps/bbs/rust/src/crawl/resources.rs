//! Daily sync of the three public RoboMaster resources branches.
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use chrono::{DateTime, TimeDelta, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx::{PgPool, types::Json};
use tokio::sync::watch;

use crate::resources::{ChangedPage, Node, Page, Update};

use super::{
    Error, Result,
    guard::Priority,
    source::{Source, invalid, wiki_data},
};

const HUB_ID: i64 = 20204847;
const BRANCH_IDS: [i64; 3] = [20216309, 20216757, 20216797];
const REVISIONS_PER_REQUEST: usize = 127;
const CHECK_INTERVAL: TimeDelta = TimeDelta::days(1);
const RETRY_INTERVAL: Duration = Duration::from_secs(3600);
const PAGE_SPACING: Duration = Duration::from_secs(5);
const NOTICE_LINKS: usize = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wiki {
    id: i64,
    tree_root: WikiRoot,
}

#[derive(Deserialize)]
struct WikiRoot {
    children: Vec<WikiNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WikiNode {
    key: i64,
    posts_id: Option<i64>,
    title: String,
    is_draft: Option<bool>,
    children: Vec<WikiNode>,
}

impl WikiNode {
    fn published(self, ids: &mut Vec<i64>) -> Result<Node> {
        let id = self
            .posts_id
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid(format!("wiki node {} has no post", self.key)))?;
        if self.title.trim().is_empty() {
            return Err(invalid(format!("wiki node {} has no title", self.key)));
        }
        ids.push(id);
        let children = self
            .children
            .into_iter()
            .filter(|node| node.is_draft == Some(false))
            .map(|node| node.published(ids))
            .collect::<Result<_>>()?;
        Ok(Node {
            id: id.to_string(),
            title: self.title,
            children,
        })
    }
}

fn catalog(wiki: Wiki) -> Result<(Vec<Node>, Vec<i64>)> {
    if wiki.id != HUB_ID {
        return Err(invalid("unexpected wiki id"));
    }
    let mut ids = Vec::new();
    let mut keys = HashSet::new();
    let mut branches = Vec::new();
    for node in wiki.tree_root.children {
        if node.is_draft == Some(false) && BRANCH_IDS.contains(&node.key) {
            if !keys.insert(node.key) {
                return Err(invalid("duplicate resources branch in the wiki"));
            }
            branches.push(node.published(&mut ids)?);
        }
    }
    if branches.len() != BRANCH_IDS.len() {
        return Err(invalid("the wiki is missing an expected resources branch"));
    }
    ids.sort_unstable();
    ids.dedup();
    Ok((branches, ids))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Revision {
    id: i64,
    update_at: DateTime<Utc>,
    state: String,
    category: String,
}

fn changes(
    ids: &[i64],
    revisions: Vec<Revision>,
    cached: &HashMap<String, DateTime<Utc>>,
) -> Result<Vec<(String, DateTime<Utc>)>> {
    let mut by_id: HashMap<_, _> = revisions.into_iter().map(|row| (row.id, row)).collect();
    let mut changed = Vec::new();
    for id in ids {
        let row = by_id
            .remove(id)
            .filter(|row| row.state == "PASS" && row.category == "WIKI")
            .ok_or_else(|| invalid(format!("missing published revision for wiki post {id}")))?;
        let id = id.to_string();
        if cached.get(&id) != Some(&row.update_at) {
            changed.push((id, row.update_at));
        }
    }
    Ok(changed)
}

pub(super) async fn sync(pool: &PgPool, source: &Source) -> Result<()> {
    let wiki = source
        .post(
            &format!("/developers-server/rest/wiki/info/{HUB_ID}"),
            json!({}),
            Priority::Background,
        )
        .await?;
    let (tree, ids) = catalog(wiki_data(wiki)?)?;
    let mut published = HashMap::new();
    let mut staged = HashMap::new();
    let known: Vec<(String, bool, DateTime<Utc>)> =
        sqlx::query_as("SELECT id, staged, updated_at FROM resource_pages")
            .fetch_all(pool)
            .await?;
    for (id, is_staged, updated_at) in known {
        if is_staged {
            staged.insert(id, updated_at);
        } else {
            published.insert(id, updated_at);
        }
    }
    let mut promote = Vec::new();
    let mut fetched = 0;
    for batch in ids.chunks(REVISIONS_PER_REQUEST) {
        let revisions = source
            .post(
                "/developers-server/rest/posts/list-by-ids",
                json!(batch),
                Priority::Background,
            )
            .await?;
        for (id, revision) in changes(batch, wiki_data(revisions)?, &published)? {
            if staged.get(&id) != Some(&revision) {
                tokio::time::sleep(PAGE_SPACING).await;
                let page = source.wiki_page(&id).await?;
                if page.updated_at < revision {
                    return Err(invalid(format!(
                        "wiki post {id} is older than its listed revision"
                    )));
                }
                stage(pool, page).await?;
                fetched += 1;
            }
            promote.push(id);
        }
    }
    publish(pool, &tree, &ids, &promote).await?;
    tracing::info!(
        pages = ids.len(),
        changed = promote.len(),
        fetched,
        "RoboMaster resources synced"
    );
    Ok(())
}

async fn stage(pool: &PgPool, page: Page) -> Result<()> {
    sqlx::query(
        "INSERT INTO resource_pages (id, staged, title, html, attachments, updated_at) \
             VALUES ($1, true, $2, $3, $4, $5) ON CONFLICT (id, staged) DO UPDATE SET \
             title = excluded.title, html = excluded.html, attachments = excluded.attachments, \
             updated_at = excluded.updated_at",
    )
    .bind(page.id)
    .bind(page.title)
    .bind(page.html)
    .bind(Json(page.attachments))
    .bind(page.updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn publish(pool: &PgPool, tree: &[Node], ids: &[i64], promote: &[String]) -> Result<()> {
    let mut tx = pool.begin().await?;
    let old_tree: Option<Json<Vec<Node>>> =
        sqlx::query_scalar("SELECT tree FROM resource_catalog WHERE id = 1 FOR UPDATE")
            .fetch_optional(&mut *tx)
            .await?;
    if !promote.is_empty() {
        sqlx::query(
            "INSERT INTO resource_pages (id, staged, title, html, attachments, updated_at) \
             SELECT id, false, title, html, attachments, updated_at FROM resource_pages \
             WHERE staged AND id = ANY($1::text[]) ON CONFLICT (id, staged) DO UPDATE SET \
             title = excluded.title, html = excluded.html, attachments = excluded.attachments, \
             updated_at = excluded.updated_at",
        )
        .bind(promote)
        .execute(&mut *tx)
        .await?;
    }
    let ids: Vec<_> = ids.iter().map(i64::to_string).collect();
    sqlx::query("DELETE FROM resource_pages WHERE staged OR id <> ALL($1::text[])")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    let synced_at = Utc::now();
    sqlx::query(
        "INSERT INTO resource_catalog (id, tree, synced_at) VALUES (1, $1, $2) \
         ON CONFLICT (id) DO UPDATE SET tree = excluded.tree, synced_at = excluded.synced_at",
    )
    .bind(Json(tree))
    .bind(synced_at)
    .execute(&mut *tx)
    .await?;
    if let Some(Json(old_tree)) = old_tree
        && let Some(changes) = notice(&old_tree, tree, promote)
    {
        sqlx::query("INSERT INTO resource_updates (synced_at, changes) VALUES ($1, $2)")
            .bind(synced_at)
            .bind(Json(changes))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn notice(before: &[Node], after: &[Node], promoted: &[String]) -> Option<Update> {
    let tree_changed = before != after;
    if !tree_changed && promoted.is_empty() {
        return None;
    }
    let old: HashSet<_> = flatten(before)
        .into_iter()
        .map(|node| node.id.as_str())
        .collect();
    let current = flatten(after);
    let new: HashSet<_> = current.iter().map(|node| node.id.as_str()).collect();
    let mut changed: HashSet<_> = promoted.iter().map(String::as_str).collect();
    let updated = changed.intersection(&old).count();
    let pages = current
        .into_iter()
        .filter(|node| changed.remove(node.id.as_str()))
        .take(NOTICE_LINKS)
        .map(|node| ChangedPage {
            id: node.id.clone(),
            title: node.title.clone(),
        })
        .collect();
    Some(Update {
        added: new.difference(&old).count(),
        updated,
        removed: old.difference(&new).count(),
        tree_changed,
        pages,
    })
}

fn flatten(tree: &[Node]) -> Vec<&Node> {
    let mut pending: Vec<_> = tree.iter().rev().collect();
    let mut nodes = Vec::new();
    while let Some(node) = pending.pop() {
        nodes.push(node);
        pending.extend(node.children.iter().rev());
    }
    nodes
}

async fn next_check(pool: &PgPool) -> Result<Duration> {
    let synced_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT synced_at FROM resource_catalog WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    Ok(synced_at
        .and_then(|at| (at + CHECK_INTERVAL - Utc::now()).to_std().ok())
        .unwrap_or_default())
}

pub(super) async fn work(pool: &PgPool, source: &Source, mut stop: watch::Receiver<bool>) {
    let observe = async {
        loop {
            let result = async {
                tokio::time::sleep(next_check(pool).await?).await;
                sync(pool, source).await
            }
            .await;
            if let Err(error) = result {
                let delay = match error {
                    Error::Throttled { until, .. } => {
                        Duration::from_millis((until - Utc::now().timestamp_millis()).max(0) as u64)
                            .max(RETRY_INTERVAL)
                    }
                    _ => RETRY_INTERVAL,
                };
                tracing::warn!(%error, retry_seconds = delay.as_secs(), "RoboMaster resources sync deferred");
                tokio::time::sleep(delay).await;
            }
        }
    };
    tokio::select! {
        _ = observe => {},
        _ = stop.wait_for(|stopping| *stopping) => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_counts_content_and_catalog_changes() {
        let node = |id: &str, title: &str| Node {
            id: id.into(),
            title: title.into(),
            children: Vec::new(),
        };
        let before = [node("2", "Existing"), node("3", "Removed")];
        assert!(notice(&before, &before, &[]).is_none());

        let renamed = [node("2", "Renamed"), node("3", "Removed")];
        let tree_only = notice(&before, &renamed, &[]).expect("renaming changes the catalog");
        assert!(tree_only.tree_changed);
        assert!(tree_only.pages.is_empty());

        let after = [node("2", "Existing"), node("1", "New")];
        let update = notice(&before, &after, &["1".into(), "2".into()])
            .expect("new catalog and bodies are announceable");
        assert_eq!((update.added, update.updated, update.removed), (1, 1, 1));
        assert_eq!(
            update
                .pages
                .iter()
                .map(|page| page.id.as_str())
                .collect::<Vec<_>>(),
            ["2", "1"]
        );
    }

    fn node(key: i64, post: Option<i64>, draft: bool, children: Vec<WikiNode>) -> WikiNode {
        WikiNode {
            key,
            posts_id: post,
            title: format!("Node {key}"),
            is_draft: Some(draft),
            children,
        }
    }

    #[test]
    fn catalog_keeps_upstream_order_and_published_subtrees() {
        let wiki = Wiki {
            id: HUB_ID,
            tree_root: WikiRoot {
                children: vec![
                    node(BRANCH_IDS[2], Some(3), false, vec![]),
                    node(404, None, false, vec![]),
                    node(
                        BRANCH_IDS[0],
                        Some(1),
                        false,
                        vec![
                            node(102, None, true, vec![node(103, Some(5), false, vec![])]),
                            node(101, Some(4), false, vec![]),
                        ],
                    ),
                    node(BRANCH_IDS[1], Some(2), false, vec![]),
                ],
            },
        };
        let (tree, ids) = catalog(wiki).expect("all three expected branches are present");
        assert_eq!(ids, [1, 2, 3, 4]);
        assert_eq!(
            tree.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
            ["3", "1", "2"]
        );
        assert_eq!(tree[1].children[0].id, "4");
    }

    #[test]
    fn fetches_only_missing_or_changed_bodies_and_rejects_incomplete_metadata() {
        let current = DateTime::from_timestamp(2, 0).expect("timestamp in range");
        let older = DateTime::from_timestamp(1, 0).expect("timestamp in range");
        let cached = HashMap::from([("1".into(), current), ("2".into(), older)]);
        let revisions = |ids: &[i64]| {
            ids.iter()
                .map(|&id| Revision {
                    id,
                    update_at: current,
                    state: "PASS".into(),
                    category: "WIKI".into(),
                })
                .collect()
        };
        let ids = [1, 2, 3];
        assert_eq!(
            changes(&ids, revisions(&[3, 1, 2]), &cached).unwrap(),
            [("2".into(), current), ("3".into(), current)]
        );
        assert!(changes(&ids, revisions(&[1, 2]), &cached).is_err());
    }
}
