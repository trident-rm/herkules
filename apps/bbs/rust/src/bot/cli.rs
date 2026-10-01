use super::{
    command::Message,
    store::{Result, Store},
};
use crate::library::Library;
use chrono::Utc;
use herkules_feishu::{Feishu, Outbound, Unavailable};
use serde_json::Value;
use sqlx::{Connection, PgConnection, postgres::PgPoolOptions};
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;
const LOCK: i64 = 0x42425342;
fn env(key: &str) -> Result<String> {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| std::io::Error::other(format!("{key} is required")).into())
}
fn text(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().filter(|s| !s.is_empty()).map(String::from)
}
pub async fn admit(store: &Store, event: Value, bot: &str) -> Result<()> {
    let event = event.get("event").unwrap_or(&event);
    let at = Utc::now();
    if let Some(message) = event.get("message") {
        if message["message_type"] != "text" {
            return Ok(());
        }
        let mut content =
            serde_json::from_str::<Value>(message["content"].as_str().unwrap_or_default())
                .ok()
                .and_then(|v| v["text"].as_str().map(String::from))
                .unwrap_or_default();
        let mut mentioned = false;
        let mut all = content.contains("@_all");
        for mention in message["mentions"].as_array().into_iter().flatten() {
            let key = mention["key"].as_str().unwrap_or_default();
            let name = mention["name"].as_str().unwrap_or_default();
            if key == "@_all" || mention["id"]["open_id"] == "all" {
                all = true
            }
            let is_bot = mention["id"]["open_id"].as_str() == Some(bot);
            mentioned |= is_bot;
            if !key.is_empty() {
                if is_bot {
                    let pattern = format!(r"\s?{}\s?", regex::escape(key));
                    content = regex::Regex::new(&pattern)?
                        .replace_all(&content, " ")
                        .into_owned();
                } else if !name.is_empty() {
                    content = content.replace(key, &format!("@{name}"));
                }
            }
        }
        content = regex::Regex::new(r"[ \t]{2,}")?
            .replace_all(&content, " ")
            .trim_matches(crate::library::js_whitespace)
            .to_string();
        let chat_type = text(message, "chat_type").unwrap_or_default();
        if !["p2p", "group"].contains(&chat_type.as_str()) || (chat_type == "group" && all) {
            return Ok(());
        }
        let m = Message {
            message_id: text(message, "message_id")
                .ok_or_else(|| std::io::Error::other("message id missing"))?,
            chat_id: text(message, "chat_id")
                .ok_or_else(|| std::io::Error::other("chat id missing"))?,
            chat_type,
            content,
            raw_content_type: "text".into(),
            mentioned_bot: mentioned,
            create_time: message["create_time"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),
        };
        store.accept_message(&m, at).await?;
    } else if let Some(action) = event.get("action") {
        let message = text(&event["context"], "open_message_id");
        let chat = text(&event["context"], "open_chat_id");
        if let (Some(message), Some(chat)) = (message, chat) {
            store
                .accept_action(&message, &chat, action["value"].clone(), at)
                .await?;
        }
    } else if let (Some(operator), Some(key)) = (
        event
            .pointer("/operator/operator_id/open_id")
            .and_then(Value::as_str),
        event["event_key"].as_str(),
    ) {
        if !operator.starts_with("ou_")
            || operator.len() < 4
            || operator.len() > 67
            || !operator[3..].bytes().all(|c| c.is_ascii_alphanumeric())
            || key.is_empty()
            || key.len() > 64
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Ok(());
        }
        let timestamp = event["timestamp"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| event["timestamp"].as_f64())
            .filter(|n| n.is_finite() && *n > 0.0)
            .map(|n| n as i64)
            .unwrap_or(at.timestamp_millis());
        store.accept_menu(operator, key, timestamp, at).await?;
    }
    Ok(())
}
pub async fn run(args: &[String]) -> Result<u8> {
    if !args.is_empty() {
        return Err(std::io::Error::other("usage: herkules-bbs bot").into());
    }
    let database = env("DATABASE_URL")?;
    let origin = url::Url::parse(&env("APP_ORIGIN")?)?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err(std::io::Error::other("APP_ORIGIN must be HTTP(S)").into());
    }
    if std::env::var("SEARCH_INDEX").is_ok_and(|v| v != "trgm") {
        return Err(std::io::Error::other("Rust bot requires SEARCH_INDEX=trgm").into());
    }
    let app_id = env("FEISHU_APP_ID")?;
    let secret = env("FEISHU_APP_SECRET")?;
    let chat = env("FEISHU_ANNOUNCEMENT_CHAT_ID")?;
    run_with(
        database,
        origin.origin().ascii_serialization(),
        chat,
        Feishu::new(app_id, secret)?,
    )
    .await
}

/// Explicit transport injection for fixture tests; production uses the fixed Feishu origin.
pub async fn run_with(
    database: String,
    origin: String,
    chat: String,
    transport: Feishu,
) -> Result<u8> {
    let origin = url::Url::parse(&origin)?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(5))
        .after_connect(|c, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout='5s'").execute(c).await?;
                Ok(())
            })
        })
        .connect(&database)
        .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        if sqlx::query("SELECT 1 FROM bot_state LIMIT 0")
            .execute(&pool)
            .await
            .is_ok()
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                std::io::Error::other("bot schema unavailable; run migrations first").into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let mut lock = PgConnection::connect(&database).await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(LOCK)
        .fetch_one(&mut lock)
        .await?;
    if !acquired {
        pool.close().await;
        return Ok(3);
    }
    let (quit_tx, mut quit) = watch::channel(false);
    let (lost_tx, mut lost) = watch::channel(false);
    let (lock_stop, mut lock_quit) = watch::channel(false);
    let lock_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {_ = lock_quit.changed()=>break,_ = ticker.tick()=>{if !matches!(tokio::time::timeout(Duration::from_secs(5),sqlx::query("SELECT 1").execute(&mut lock)).await,Ok(Ok(_))){let _=lost_tx.send(true);break;}}}
        }
        let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(LOCK)
            .execute(&mut lock)
            .await;
    });
    let signal_tx = quit_tx.clone();
    let signal = tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = term.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        let _ = signal_tx.send(true);
    });
    let store = Arc::new(Store {
        pool: pool.clone(),
        origin: origin.origin().ascii_serialization(),
        chat,
    });
    let library = Library::new(pool.clone());
    let result = async {
        let bot = transport.bot_open_id().await?;
        let inbound = store.clone();
        let mut connection = transport.websocket(move |event| {
            let store = inbound.clone();
            let bot = bot.clone();
            async move { admit(&store, event, &bot).await.map_err(|_| Unavailable) }
        })?;
        let result = work(
            &store,
            &library,
            &transport,
            &mut connection,
            &mut quit,
            &mut lost,
        )
        .await;
        connection.close().await;
        result
    }
    .await;
    let _ = quit_tx.send(true);
    signal.abort();
    let _ = signal.await;
    let _ = lock_stop.send(true);
    let _ = lock_task.await;
    pool.close().await;
    result?;
    Ok(0)
}

async fn work(
    store: &Store,
    library: &Library,
    transport: &Feishu,
    connection: &mut herkules_feishu::Connection,
    quit: &mut watch::Receiver<bool>,
    lost: &mut watch::Receiver<bool>,
) -> Result<()> {
    tokio::select! {
        ready = connection.connected() => ready?,
        _ = quit.changed() => return Ok(()),
        _ = lost.changed() => return Err(std::io::Error::other("bot lock session lost").into()),
    }
    let baseline = store.activate(Utc::now()).await?;
    tracing::info!(baseline, "bot ready");
    let mut reconciled = tokio::time::Instant::now() - Duration::from_secs(30);
    loop {
        if *quit.borrow() {
            break;
        }
        if *lost.borrow() {
            return Err(std::io::Error::other("bot lock session lost").into());
        }
        if connection.task.is_finished() {
            return Err(std::io::Error::other("Feishu connection stopped").into());
        }
        let now = Utc::now();
        if reconciled.elapsed() >= Duration::from_secs(30) {
            let report = store.reconcile(now).await?;
            tracing::debug!(%report, "bot reconciled");
            reconciled = tokio::time::Instant::now();
        }
        store.plan(library, now).await?;
        if let Some(delivery) = store.lease(now).await? {
            // SIGTERM lets this bounded send finish while the lock monitor stays alive.
            // Lock loss cancels the waiter; the durable lease retains its UUID for recovery.
            let outcome = tokio::select! {
                outcome = transport.send(Outbound {
                    kind: &delivery.kind, chat_id: &delivery.chat_id,
                    reply_to: delivery.reply_to_message_id.as_deref(),
                    msg_type: &delivery.msg_type, content: &delivery.content, uuid: &delivery.uuid,
                }) => outcome,
                _ = lost.changed() => return Err(std::io::Error::other("bot lock session lost during delivery").into()),
            };
            if store
                .settle(&delivery, &outcome, Utc::now(), rand::random())
                .await?
            {
                return Err(std::io::Error::other("fatal Feishu delivery failure").into());
            }
            continue;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {},
            _ = quit.changed() => break,
            _ = lost.changed() => return Err(std::io::Error::other("bot lock session lost").into()),
        }
    }
    Ok(())
}
