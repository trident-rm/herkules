//! Read models for the RoboMaster Rules and Resources Hub mirror.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, types::Json};

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 19
        && !id.starts_with('0')
        && id.bytes().all(|c| c.is_ascii_digit())
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct Node {
    pub id: String,
    pub title: String,
    pub children: Vec<Node>,
}

/// A single completed wiki sync with changes to announce.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct Update {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub tree_changed: bool,
    pub pages: Vec<ChangedPage>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ChangedPage {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub tree: Vec<Node>,
    pub synced_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct Attachment {
    pub url: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub id: String,
    pub title: String,
    pub html: String,
    pub attachments: Vec<Attachment>,
    #[serde(serialize_with = "serialize_time")]
    pub updated_at: DateTime<Utc>,
}

fn serialize_time<S: serde::Serializer>(
    at: &DateTime<Utc>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&crate::library::iso(*at))
}

pub(crate) async fn catalog(pool: &PgPool) -> Result<Catalog, sqlx::Error> {
    let row: Option<(Json<Vec<Node>>, DateTime<Utc>)> =
        sqlx::query_as("SELECT tree, synced_at FROM resource_catalog WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    let (tree, synced_at) = match row {
        Some((Json(tree), at)) => (tree, Some(crate::library::iso(at))),
        None => (Vec::new(), None),
    };
    Ok(Catalog { tree, synced_at })
}

pub(crate) async fn title(pool: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT title FROM resource_pages WHERE id = $1 AND NOT staged")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub(crate) async fn page(pool: &PgPool, id: &str) -> Result<Option<Page>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, String, Json<Vec<Attachment>>, DateTime<Utc>)>(
        "SELECT title, html, attachments, updated_at FROM resource_pages WHERE id = $1 AND NOT staged",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(
        row.map(|(title, html, Json(attachments), updated_at)| Page {
            id: id.into(),
            title,
            html,
            attachments,
            updated_at,
        }),
    )
}
