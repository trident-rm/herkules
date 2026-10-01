use chrono::{DateTime, Utc};
use herkules_bbs::{
    bot::{
        command, present,
        store::{Delivery, Outcome, Store},
    },
    library::Library,
};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use std::io::{self, BufRead, Write};
#[tokio::main]
async fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = call(input)
            .await
            .unwrap_or_else(|e| json!({"error":e.to_string()}));
        println!("{result}");
        io::stdout().flush().unwrap();
    }
}
async fn call(v: Value) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let text = |key: &str| v[key].as_str().unwrap_or_default();
    Ok(match text("op") {
        "command" => command::as_value(command::parse(&serde_json::from_value(
            v["message"].clone(),
        )?)),
        "menu" => command::as_value(command::menu(text("key"))),
        "action" => serde_json::to_value(command::action(v["value"].clone()))?,
        "present" => {
            let p = match text("kind") {
                "help" => present::help(text("chatType")),
                "unknown" => present::error("unknown", text("name")),
                "invalid" => present::error(text("reason"), ""),
                "latest" => present::latest(v["items"].as_array().unwrap(), text("origin")),
                "status" => present::status(&v["status"], text("origin")),
                "article" => present::article(&v["article"]),
                "digest" => present::digest(text("day"), v["articles"].as_array().unwrap()),
                "search" => present::search(&v["view"]),
                _ => panic!("unknown presenter"),
            };
            serde_json::to_value(p)?
        }
        "day" => {
            json!({"day":present::day(text("at").parse()?),"due":present::due(text("day")).map(|d|d.to_rfc3339_opts(chrono::SecondsFormat::Millis,true))})
        }
        _ => {
            let pool = PgPoolOptions::new()
                .max_connections(2)
                .connect(text("database"))
                .await?;
            let store = Store {
                pool: pool.clone(),
                origin: text("origin").into(),
                chat: text("chat").into(),
            };
            let at: DateTime<Utc> = text("at").parse()?;
            let r = match text("op") {
                "admit" => {
                    herkules_bbs::bot::cli::admit(&store, v["event"].clone(), text("botId"))
                        .await?;
                    json!(true)
                }
                "status" => Library::new(pool.clone()).status().await?,
                "activate" => json!(store.activate(at).await?),
                "reconcile" => store.reconcile(at).await?,
                "accept" => json!(
                    store
                        .accept_message(&serde_json::from_value(v["message"].clone())?, at)
                        .await?
                ),
                "acceptAction" => json!(
                    store
                        .accept_action(text("messageId"), text("chatId"), v["value"].clone(), at)
                        .await?
                ),
                "acceptMenu" => json!(
                    store
                        .accept_menu(
                            text("operator"),
                            text("key"),
                            v["timestamp"].as_i64().unwrap(),
                            at
                        )
                        .await?
                ),
                "lease" => serde_json::to_value(store.lease(at).await?)?,
                "settle" => {
                    let d: Delivery = serde_json::from_value(v["delivery"].clone())?;
                    let o: Outcome = serde_json::from_value(v["outcome"].clone())?;
                    json!(store.settle(&d, &o, at, 0.0).await?)
                }
                "plan" => json!(store.plan(&Library::new(pool.clone()), at).await?),
                _ => panic!("unknown operation"),
            };
            pool.close().await;
            r
        }
    })
}
