//! Local lifecycle fixture. This executable cannot contact the real Feishu service.
use axum::{
    Json, Router,
    extract::WebSocketUpgrade,
    extract::ws::Message,
    routing::{get, post},
};
use larksuite_oapi_sdk_rs::ws::proto::{Frame, Header};
use prost::Message as _;
use serde_json::json;
use std::{io::Write, time::Duration};
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let database = args[0].clone();
    let slow = args.get(1).is_some_and(|s| s == "slow");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/open-apis/auth/v3/tenant_access_token/internal", post(|| async {
            Json(json!({"code":0,"expire":7200,"tenant_access_token":"fixture-token"}))
        }))
        .route("/open-apis/bot/v3/info/", get(|| async {
            Json(json!({"code":0,"bot":{"open_id":"ou_bot"}}))
        }))
        .route("/callback/ws/endpoint", post(move || async move {
            Json(json!({"code":0,"data":{
                "URL":format!("ws://{addr}/ws?service_id=1&device_id=fixture"),
                "ClientConfig":{"PingInterval":60,"ReconnectCount":0,"ReconnectInterval":1,"ReconnectNonce":0}
            }}))
        }))
        .route("/open-apis/im/v1/messages/{id}/reply", post(move || async move {
            println!("send_started");
            std::io::stdout().flush().unwrap();
            if slow { tokio::time::sleep(Duration::from_secs(4)).await; }
            Json(json!({"code":0,"data":{"message_id":"om_fixture_reply"}}))
        }))
        .route("/ws", get(move |upgrade: WebSocketUpgrade| async move {
            upgrade.on_upgrade(move |mut ws| async move {
                println!("connected");
                std::io::stdout().flush().unwrap();
                if slow {
                    let payload = json!({
                        "schema":"2.0",
                        "header":{"event_type":"im.message.receive_v1","event_id":"fixture"},
                        "event":{"message":{
                            "message_id":"om_fixture","chat_id":"oc_fixture","chat_type":"p2p",
                            "message_type":"text","content":json!({"text":"/help"}).to_string(),
                            "create_time":chrono::Utc::now().timestamp_millis().to_string()
                        }}
                    });
                    let frame = Frame {
                        seq_id: 1, log_id: 0, service: 1, method: 1,
                        headers: vec![
                            Header { key: "type".into(), value: "event".into() },
                            Header { key: "message_id".into(), value: "fixture".into() },
                        ],
                        payload: Some(payload.to_string().into_bytes()),
                        ..Default::default()
                    };
                    ws.send(Message::Binary(frame.encode_to_vec().into())).await.unwrap();
                }
                while ws.recv().await.is_some() {}
            })
        }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let transport = herkules_feishu::Feishu::with_origin(
        "app".into(),
        "fixture-secret".into(),
        format!("http://{addr}"),
    )
    .unwrap();
    let result = herkules_bbs::bot::cli::run_with(
        database,
        "https://bbs.example.test".into(),
        "oc_announcement".into(),
        transport,
    )
    .await;
    server.abort();
    let _ = server.await;
    match result {
        Ok(code) => std::process::exit(code.into()),
        Err(e) => {
            eprintln!("fixture worker: {e}");
            std::process::exit(1)
        }
    }
}
