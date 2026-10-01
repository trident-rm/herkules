use super::{
    command::{self, Command, Message},
    present::{self, Payload},
};
use crate::{
    feed::{FeedError, FeedQuery},
    library::Library,
    search::SearchError,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub kind: String,
    pub chat_id: String,
    pub reply_to_message_id: Option<String>,
    pub msg_type: String,
    pub content: String,
    pub uuid: String,
    pub lease_token: String,
    pub attempt_no: i32,
}
pub use herkules_feishu::Outcome;
#[derive(Clone)]
pub struct Store {
    pub pool: PgPool,
    pub origin: String,
    pub chat: String,
}
fn err(message: &str) -> Error {
    std::io::Error::other(message).into()
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
impl Store {
    pub async fn activate(&self, at: DateTime<Utc>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let state = sqlx::query("SELECT announcement_chat_id FROM bot_state WHERE id=1 FOR UPDATE")
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(state) = state {
            if state.try_get::<String, _>("announcement_chat_id")? != self.chat {
                return Err(err(
                    "FEISHU_ANNOUNCEMENT_CHAT_ID does not match the chat fixed at bot activation",
                ));
            }
            return Ok(false);
        }
        sqlx::query("INSERT INTO bot_state(id,activated_at,announcement_chat_id,last_reconciled_at) VALUES(1,$1,$2,$1)").bind(at).bind(&self.chat).execute(&mut*tx).await?;
        sqlx::query("INSERT INTO bot_article_decisions(source_id,source_article_id,status,decided_at) SELECT source_id,source_article_id,'baseline',$1 FROM articles").bind(at).execute(&mut*tx).await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn reconcile(&self, at: DateTime<Utc>) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        expire(&mut tx, at).await?;
        let digests = self.seal(&mut tx, at).await?;
        let activated: DateTime<Utc> =
            sqlx::query_scalar("SELECT activated_at FROM bot_state WHERE id=1 FOR UPDATE")
                .fetch_one(&mut *tx)
                .await?;
        let day = NaiveDate::parse_from_str(&present::day(at), "%Y-%m-%d")?;
        sqlx::query(
            "INSERT INTO bot_days(assignment_day,created_at) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(day)
        .bind(at)
        .execute(&mut *tx)
        .await?;
        sqlx::query("SELECT assignment_day FROM bot_days WHERE assignment_day=$1 FOR UPDATE")
            .bind(day)
            .execute(&mut *tx)
            .await?;
        let ineligible:i64=sqlx::query_scalar("WITH inserted AS(INSERT INTO bot_article_decisions(source_id,source_article_id,status,decided_at) SELECT a.source_id,a.source_article_id,CASE WHEN a.published_at IS NULL THEN 'ineligible_null_publication' ELSE 'ineligible_pre_activation' END,$1 FROM articles a LEFT JOIN bot_article_decisions d ON d.source_id=a.source_id AND d.source_article_id=a.source_article_id WHERE d.source_id IS NULL AND(a.published_at IS NULL OR a.published_at<=$2) ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) FROM inserted").bind(at).bind(activated).fetch_one(&mut*tx).await?;
        let mut occupied:Vec<i32>=sqlx::query_scalar("SELECT immediate_slot FROM bot_article_decisions WHERE assignment_day=$1 AND immediate_slot IS NOT NULL").bind(day).fetch_all(&mut*tx).await?;
        let rows=sqlx::query("SELECT a.id,a.source_id,a.source_article_id,a.title,a.introduction,a.body_text,a.published_at FROM articles a JOIN article_search s ON s.article_id=a.id LEFT JOIN bot_article_decisions d ON d.source_id=a.source_id AND d.source_article_id=a.source_article_id WHERE d.source_id IS NULL AND a.published_at>$1 AND a.status='fetched' ORDER BY a.published_at,a.source_id,a.source_article_id").bind(activated).fetch_all(&mut*tx).await?;
        let mut immediate = 0;
        let mut overflow = 0;
        for row in rows {
            let slot = (1..=3).find(|n| !occupied.contains(n));
            if let Some(n) = slot {
                occupied.push(n)
            }
            let source: String = row.try_get("source_id")?;
            let article_source: String = row.try_get("source_article_id")?;
            let article: String = row.try_get("id")?;
            let title: String = row.try_get("title")?;
            let intro: Option<String> = row.try_get("introduction")?;
            let body: Option<String> = row.try_get("body_text")?;
            let excerpt = intro
                .filter(|s| !s.trim_matches(crate::library::js_whitespace).is_empty())
                .map(|s| s.trim_matches(crate::library::js_whitespace).to_string())
                .or_else(|| {
                    body.map(|s| {
                        s.split(crate::library::js_whitespace)
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|s| !s.is_empty())
                    .map(|s| command::slice(&s, 0, 200))
                });
            let published: DateTime<Utc> = row.try_get("published_at")?;
            let url = format!("{}/articles/{article}", self.origin);
            sqlx::query("INSERT INTO bot_article_decisions(source_id,source_article_id,status,decided_at,assignment_day,immediate_slot,article_id,title,excerpt,published_at,article_link) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&source).bind(&article_source).bind(if slot.is_some(){"immediate"}else{"overflow"}).bind(at).bind(day).bind(slot).bind(article).bind(&title).bind(&excerpt).bind(published).bind(&url).execute(&mut*tx).await?;
            if slot.is_some() {
                let p =
                    present::article(&json!({"title":title,"excerpt":excerpt,"articleLink":url}));
                let delivery = insert(
                    &mut tx,
                    "article",
                    &format!("article:{source}:{article_source}"),
                    &self.chat,
                    None,
                    &p,
                    at,
                    at,
                )
                .await?;
                sqlx::query("UPDATE bot_article_decisions SET delivery_id=$1 WHERE source_id=$2 AND source_article_id=$3").bind(delivery).bind(source).bind(article_source).execute(&mut*tx).await?;
                immediate += 1
            } else {
                overflow += 1
            }
        }
        sqlx::query("UPDATE bot_state SET last_reconciled_at=$1 WHERE id=1")
            .bind(at)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(
            json!({"baseline":false,"immediate":immediate,"overflow":overflow,"ineligible":ineligible,"digests":digests}),
        )
    }
    pub async fn accept_message(&self, m: &Message, at: DateTime<Utc>) -> Result<&'static str> {
        if command::parse(m) == Command::Ignore {
            return Ok("ignored");
        }
        self.receipt(
            &m.message_id,
            &m.chat_id,
            &m.chat_type,
            &m.raw_content_type,
            &command::slice(&m.content, 0, 1000),
            m.create_time,
            at,
        )
        .await
    }
    pub async fn accept_action(
        &self,
        message: &str,
        chat: &str,
        value: Value,
        at: DateTime<Utc>,
    ) -> Result<&'static str> {
        let Some(a) = command::action(value) else {
            return Ok("ignored");
        };
        self.receipt(
            &command::receipt_id(message, &a),
            chat,
            &a.chat_type,
            "card_action",
            &json!({"cardMessageId":message,"value":a}).to_string(),
            at.timestamp_millis(),
            at,
        )
        .await
    }
    pub async fn accept_menu(
        &self,
        operator: &str,
        key: &str,
        timestamp: i64,
        at: DateTime<Utc>,
    ) -> Result<&'static str> {
        self.receipt(
            &format!("menu:{operator}:{key}:{timestamp}"),
            operator,
            "p2p",
            "bot_menu",
            &command::slice(key, 0, 200),
            timestamp,
            at,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn receipt(
        &self,
        message: &str,
        chat: &str,
        chat_type: &str,
        content_type: &str,
        content: &str,
        created: i64,
        at: DateTime<Utc>,
    ) -> Result<&'static str> {
        let created = DateTime::from_timestamp_millis(created)
            .ok_or_else(|| err("invalid event timestamp"))?;
        let result=sqlx::query("INSERT INTO bot_inbound_receipts(message_id,chat_id,chat_type,raw_content_type,content,created_at_feishu,admitted_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(message_id) DO NOTHING").bind(message).bind(chat).bind(chat_type).bind(content_type).bind(content).bind(created).bind(at).execute(&self.pool).await?;
        Ok(if result.rows_affected() > 0 {
            "accepted"
        } else {
            "duplicate"
        })
    }
    pub async fn plan(&self, library: &Library, at: DateTime<Utc>) -> Result<bool> {
        let token = id();
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE bot_inbound_receipts SET state='pending',lease_token=NULL,leased_until=NULL WHERE state='leased' AND leased_until<=$1").bind(at).execute(&mut*tx).await?;
        let Some(r)=sqlx::query("SELECT * FROM bot_inbound_receipts WHERE state='pending' ORDER BY admitted_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetch_optional(&mut*tx).await?else{return Ok(false)};
        let message: String = r.try_get("message_id")?;
        sqlx::query("UPDATE bot_inbound_receipts SET state='leased',lease_token=$1,leased_until=$2 WHERE message_id=$3").bind(&token).bind(at+Duration::minutes(2)).bind(&message).execute(&mut*tx).await?;
        tx.commit().await?;
        let result = self.plan_payload(library, &r).await;
        match result {
            Ok((payload, kind, reply)) => {
                let mut tx = self.pool.begin().await?;
                let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bot_inbound_receipts WHERE message_id=$1 AND state='leased' AND lease_token=$2)").bind(&message).bind(&token).fetch_one(&mut*tx).await?;
                if !owned {
                    return Ok(false);
                }
                let delivery = insert(
                    &mut tx,
                    &kind,
                    &format!("reply:{message}"),
                    &r.try_get::<String, _>("chat_id")?,
                    reply.as_deref(),
                    &payload,
                    at,
                    at,
                )
                .await?;
                sqlx::query("UPDATE bot_inbound_receipts SET state='planned',reply_delivery_id=$1,lease_token=NULL,leased_until=NULL,last_error=NULL WHERE message_id=$2 AND state='leased' AND lease_token=$3").bind(delivery).bind(message).bind(token).execute(&mut*tx).await?;
                tx.commit().await?;
                Ok(true)
            }
            Err(e) => {
                sqlx::query("UPDATE bot_inbound_receipts SET state='pending',lease_token=NULL,leased_until=NULL,last_error='reply planning failed' WHERE message_id=$1 AND lease_token=$2").bind(message).bind(token).execute(&self.pool).await?;
                Err(e)
            }
        }
    }
    async fn plan_payload(
        &self,
        library: &Library,
        r: &PgRow,
    ) -> Result<(Payload, String, Option<String>)> {
        let content: String = r.try_get("content")?;
        let typ: String = r.try_get("raw_content_type")?;
        let chat: String = r.try_get("chat_type")?;
        let message: String = r.try_get("message_id")?;
        if typ == "card_action" {
            let value: Value = serde_json::from_str(&content)?;
            let a = command::action(value["value"].clone())
                .ok_or_else(|| err("stored card action is not valid"))?;
            return Ok((
                self.respond_search(library, &a.q, &a.scope, a.trail, &a.chat_type)
                    .await?,
                "update".into(),
                Some(
                    value["cardMessageId"]
                        .as_str()
                        .ok_or_else(|| err("invalid card message"))?
                        .into(),
                ),
            ));
        }
        let c = if typ == "bot_menu" {
            command::menu(&content)
        } else {
            command::parse(&Message {
                message_id: message.clone(),
                chat_id: r.try_get("chat_id")?,
                chat_type: chat.clone(),
                content,
                raw_content_type: typ,
                mentioned_bot: true,
                create_time: r
                    .try_get::<DateTime<Utc>, _>("created_at_feishu")?
                    .timestamp_millis(),
            })
        };
        Ok((
            self.respond(library, c, &chat).await?,
            "reply".into(),
            if r.try_get::<String, _>("raw_content_type")? == "bot_menu" {
                None
            } else {
                Some(message)
            },
        ))
    }
    async fn respond(&self, library: &Library, c: Command, chat: &str) -> Result<Payload> {
        Ok(match c {
            Command::Search { query, scope } => {
                self.respond_search(library, &query, &scope, vec![], chat)
                    .await?
            }
            Command::Latest => {
                let page = library
                    .feed(
                        FeedQuery {
                            limit: Some("5".into()),
                            ..Default::default()
                        }
                        .validate()
                        .map_err(|_| err("invalid feed query"))?,
                    )
                    .await?;
                let v = serde_json::to_value(page)?;
                present::latest(
                    v["items"]
                        .as_array()
                        .ok_or_else(|| err("invalid feed page"))?,
                    &self.origin,
                )
            }
            Command::Status => present::status(&library.status().await?, &self.origin),
            Command::Unknown { name } => present::error("unknown", &name),
            Command::Invalid { reason } => present::error(&reason, ""),
            _ => present::help(chat),
        })
    }
    async fn respond_search(
        &self,
        library: &Library,
        q: &str,
        scope: &str,
        mut trail: Vec<String>,
        chat: &str,
    ) -> Result<Payload> {
        let make = |cursor: Option<String>| {
            FeedQuery {
                q: Some(q.into()),
                scope: Some(scope.into()),
                cursor,
                limit: Some("5".into()),
                ..Default::default()
            }
            .validate_search()
        };
        let query = match make(trail.last().cloned()) {
            Err(SearchError::Query(FeedError::InvalidCursor)) if !trail.is_empty() => {
                trail.clear();
                make(None)
            }
            r => r,
        }
        .map_err(|_| err("invalid search query"))?;
        let page = serde_json::to_value(library.search(query).await?)?;
        Ok(present::search(
            &json!({"query":q,"scope":scope,"trail":trail,"chatType":chat,"page":page,"appOrigin":self.origin,"nonce":&id()[..8]}),
        ))
    }
    pub async fn lease(&self, at: DateTime<Utc>) -> Result<Option<Delivery>> {
        let mut tx = self.pool.begin().await?;
        expire(&mut tx, at).await?;
        let Some(r)=sqlx::query("SELECT * FROM bot_deliveries WHERE state='pending' AND scheduled_at<=$1 AND next_attempt_at<=$1 ORDER BY scheduled_at,CASE kind WHEN 'digest' THEN 0 WHEN 'reply' THEN 1 WHEN 'update' THEN 1 ELSE 2 END,created_at LIMIT 1 FOR UPDATE SKIP LOCKED").bind(at).fetch_optional(&mut*tx).await?else{return Ok(None)};
        let id: String = r.try_get("id")?;
        let attempt = r.try_get::<i32, _>("attempt_count")? + 1;
        let token = Uuid::new_v4().to_string();
        sqlx::query("UPDATE bot_deliveries SET state='leased',lease_token=$1,leased_until=$2,attempt_count=$3,updated_at=$4 WHERE id=$5").bind(&token).bind(at+Duration::minutes(2)).bind(attempt).bind(at).bind(&id).execute(&mut*tx).await?;
        sqlx::query("INSERT INTO bot_delivery_attempts(id,delivery_id,lease_token,attempt_no,started_at) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4().to_string()).bind(&id).bind(&token).bind(attempt).bind(at).execute(&mut*tx).await?;
        let d = Delivery {
            id,
            kind: r.try_get("kind")?,
            chat_id: r.try_get("chat_id")?,
            reply_to_message_id: r.try_get("reply_to_message_id")?,
            msg_type: r.try_get("msg_type")?,
            content: r.try_get("content")?,
            uuid: r.try_get("uuid")?,
            lease_token: token,
            attempt_no: attempt,
        };
        tx.commit().await?;
        Ok(Some(d))
    }
    pub async fn settle(
        &self,
        d: &Delivery,
        outcome: &Outcome,
        at: DateTime<Utc>,
        jitter: f64,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let (kind, code) = match outcome {
            Outcome::Sent { .. } => ("sent", None),
            Outcome::NotSent { code, .. } => ("not_sent", Some(code)),
            Outcome::Ambiguous { code, .. } => ("ambiguous", Some(code)),
            Outcome::Permanent { code, .. } => ("permanent", Some(code)),
        };
        sqlx::query("UPDATE bot_delivery_attempts SET finished_at=$1,outcome=$2,code=$3 WHERE delivery_id=$4 AND lease_token=$5 AND finished_at IS NULL").bind(at).bind(kind).bind(code).bind(&d.id).bind(&d.lease_token).execute(&mut*tx).await?;
        if let Outcome::Sent { message_id } = outcome {
            sqlx::query("UPDATE bot_deliveries SET state='sent',feishu_message_id=$1,lease_token=NULL,leased_until=NULL,last_error=NULL,updated_at=$2 WHERE id=$3 AND state<>'sent'").bind(message_id).bind(at).bind(&d.id).execute(&mut*tx).await?;
            tx.commit().await?;
            return Ok(false);
        }
        let current =
            sqlx::query("SELECT state,lease_token FROM bot_deliveries WHERE id=$1 FOR UPDATE")
                .bind(&d.id)
                .fetch_optional(&mut *tx)
                .await?;
        if current.as_ref().is_none_or(|r| {
            r.get::<String, _>("state") == "sent"
                || r.get::<Option<String>, _>("lease_token").as_deref() != Some(&d.lease_token)
        }) {
            return Ok(false);
        }
        if let Outcome::Permanent { code, fatal } = outcome {
            sqlx::query("UPDATE bot_deliveries SET state='permanent',lease_token=NULL,leased_until=NULL,last_error=$1,updated_at=$2 WHERE id=$3 AND lease_token=$4").bind(code).bind(at).bind(&d.id).bind(&d.lease_token).execute(&mut*tx).await?;
            tx.commit().await?;
            return Ok(*fatal);
        }
        let retry = match outcome {
            Outcome::NotSent { retry_after_ms, .. } | Outcome::Ambiguous { retry_after_ms, .. } => {
                *retry_after_ms
            }
            _ => None,
        }
        .unwrap_or_else(|| {
            ((5000.0 * 2f64.powi((d.attempt_no - 1).clamp(0, 30))).min(3600000.0)
                * (1.0 + jitter.clamp(0.0, 1.0) * 0.2))
                .round() as i64
        });
        sqlx::query("UPDATE bot_deliveries SET state='pending',lease_token=NULL,leased_until=NULL,next_attempt_at=$1,last_error=$2,updated_at=$3 WHERE id=$4 AND lease_token=$5").bind(at+Duration::milliseconds(retry)).bind(code).bind(at).bind(&d.id).bind(&d.lease_token).execute(&mut*tx).await?;
        tx.commit().await?;
        Ok(false)
    }
    async fn seal(&self, tx: &mut Transaction<'_, Postgres>, at: DateTime<Utc>) -> Result<usize> {
        let day = NaiveDate::parse_from_str(&present::day(at), "%Y-%m-%d")?;
        let rows:Vec<NaiveDate>=sqlx::query_scalar("SELECT assignment_day FROM bot_days WHERE sealed_at IS NULL AND assignment_day<$1 ORDER BY assignment_day FOR UPDATE").bind(day).fetch_all(&mut**tx).await?;
        let mut created = 0;
        let mut due_index = 0;
        for day in rows {
            let text = day.to_string();
            let due = present::due(&text).ok_or_else(|| err("invalid assignment day"))?;
            if due > at {
                continue;
            }
            let members=sqlx::query("SELECT d.source_id,d.source_article_id,d.status,d.title,d.excerpt,d.article_link,d.delivery_id FROM bot_article_decisions d LEFT JOIN bot_deliveries delivery ON delivery.id=d.delivery_id WHERE d.assignment_day=$1 AND(d.status='overflow' OR(d.status='immediate' AND delivery.state='pending' AND NOT EXISTS(SELECT 1 FROM bot_delivery_attempts a WHERE a.delivery_id=delivery.id AND(a.outcome IS NULL OR a.outcome<>'not_sent')))) ORDER BY d.published_at,d.source_id,d.source_article_id").bind(day).fetch_all(&mut**tx).await?;
            let mut delivery = None;
            if !members.is_empty() {
                let articles:Vec<_>=members.iter().map(|r|Ok(json!({"title":r.try_get::<String,_>("title")?,"excerpt":r.try_get::<Option<String>,_>("excerpt")?,"articleLink":r.try_get::<String,_>("article_link")?}))).collect::<std::result::Result<_,sqlx::Error>>()?;
                let p = present::digest(&text, &articles);
                let scheduled = due.max(at + Duration::minutes(due_index));
                let d = insert(
                    tx,
                    "digest",
                    &format!("digest:{text}"),
                    &self.chat,
                    None,
                    &p,
                    scheduled,
                    at,
                )
                .await?;
                for (i, r) in members.iter().enumerate() {
                    sqlx::query("UPDATE bot_article_decisions SET digest_delivery_id=$1,digest_ordinal=$2 WHERE source_id=$3 AND source_article_id=$4").bind(&d).bind(i as i32+1).bind(r.try_get::<String,_>("source_id")?).bind(r.try_get::<String,_>("source_article_id")?).execute(&mut**tx).await?;
                    if let Some(original) = r.try_get::<Option<String>, _>("delivery_id")? {
                        sqlx::query("UPDATE bot_deliveries SET state='cancelled',updated_at=$1 WHERE id=$2 AND state='pending'").bind(at).bind(original).execute(&mut**tx).await?;
                    }
                }
                delivery = Some(d);
                created += 1
            }
            sqlx::query("UPDATE bot_days SET sealed_at=$1,digest_delivery_id=$2 WHERE assignment_day=$3 AND sealed_at IS NULL").bind(at).bind(delivery).bind(day).execute(&mut**tx).await?;
            due_index += 1
        }
        Ok(created)
    }
}
#[allow(clippy::too_many_arguments)]
async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    key: &str,
    chat: &str,
    reply: Option<&str>,
    payload: &Payload,
    scheduled: DateTime<Utc>,
    at: DateTime<Utc>,
) -> Result<String> {
    let id = id();
    sqlx::query("INSERT INTO bot_deliveries(id,kind,logical_key,chat_id,reply_to_message_id,msg_type,content,payload_hash,uuid,scheduled_at,state,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$10,$11,$11)").bind(&id).bind(kind).bind(key).bind(chat).bind(reply).bind(&payload.msg_type).bind(&payload.content).bind(&payload.hash).bind(Uuid::new_v4().to_string()).bind(scheduled).bind(at).execute(&mut**tx).await?;
    Ok(id)
}
async fn expire(tx: &mut Transaction<'_, Postgres>, at: DateTime<Utc>) -> Result<()> {
    sqlx::query("UPDATE bot_delivery_attempts a SET finished_at=$1,outcome='ambiguous',code='lease_expired' FROM bot_deliveries d WHERE a.delivery_id=d.id AND a.lease_token=d.lease_token AND a.finished_at IS NULL AND d.state='leased' AND d.leased_until<=$1").bind(at).execute(&mut**tx).await?;
    sqlx::query("UPDATE bot_deliveries SET state='pending',lease_token=NULL,leased_until=NULL,next_attempt_at=$1,last_error='lease_expired',updated_at=$1 WHERE state='leased' AND leased_until<=$1").bind(at).execute(&mut**tx).await?;
    Ok(())
}
