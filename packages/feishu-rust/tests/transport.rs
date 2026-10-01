use axum::{
    Json, Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch, post},
};
use herkules_feishu::{Feishu, Outbound, Outcome, Unavailable};
use larksuite_oapi_sdk_rs::ws::proto::{Frame, Header};
use prost::Message as _;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, oneshot};
#[derive(Clone, Default)]
struct Fixture {
    requests: Arc<Mutex<Vec<Value>>>,
    token_calls: Arc<AtomicUsize>,
    status: Arc<Mutex<u16>>,
    body: Arc<Mutex<Value>>,
}
async fn token(State(s): State<Fixture>) -> Json<Value> {
    s.token_calls.fetch_add(1, Ordering::SeqCst);
    Json(json!({"code":0,"expire":7200,"tenant_access_token":"fixture-token"}))
}
async fn send(State(s): State<Fixture>, Json(body): Json<Value>) -> impl IntoResponse {
    s.requests.lock().await.push(body);
    (
        StatusCode::from_u16(*s.status.lock().await).unwrap(),
        [("retry-after", "2")],
        Json(s.body.lock().await.clone()),
    )
}
async fn start(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, server)
}
#[tokio::test]
async fn preserves_uuid_frozen_content_and_single_attempt_classification() {
    let s = Fixture::default();
    *s.status.lock().await = 200;
    *s.body.lock().await = json!({"code":0,"data":{"message_id":"om_result"}});
    let app = Router::new()
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(token),
        )
        .route("/open-apis/im/v1/messages", post(send))
        .route("/open-apis/im/v1/messages/{id}/reply", post(send))
        .route("/open-apis/im/v1/messages/{id}", patch(send))
        .with_state(s.clone());
    let (origin, server) = start(app).await;
    let client = Feishu::with_origin("app".into(), "secret".into(), origin).unwrap();
    let out = || Outbound {
        kind: "reply",
        chat_id: "oc_chat",
        reply_to: None,
        msg_type: "interactive",
        content: "{\"schema\":\"2.0\"}",
        uuid: "persisted-uuid",
    };
    assert!(matches!(client.send(out()).await,Outcome::Sent{message_id}if message_id=="om_result"));
    *s.status.lock().await = 429;
    *s.body.lock().await = json!({"code":99991400});
    assert!(matches!(
        client.send(out()).await,
        Outcome::NotSent {
            retry_after_ms: Some(2000),
            ..
        }
    ));
    assert_eq!(
        s.requests.lock().await.len(),
        2,
        "the outbox must own retry decisions"
    );
    let requests = s.requests.lock().await;
    assert_eq!(requests[0]["uuid"], "persisted-uuid");
    assert_eq!(requests[1]["content"], requests[0]["content"]);
    drop(requests);
    assert_eq!(s.token_calls.load(Ordering::SeqCst), 1);
    for status in [401, 403] {
        *s.status.lock().await = status;
        assert!(matches!(
            client.send(out()).await,
            Outcome::Permanent { fatal: true, .. }
        ));
    }
    *s.status.lock().await = 200;
    *s.body.lock().await = json!({"code":0});
    assert!(
        matches!(client.send(out()).await,Outcome::Ambiguous{code,..}if code=="missing_message_id")
    );
    assert!(
        matches!(client.send(Outbound{kind:"update",chat_id:"oc_chat",reply_to:Some("om_card"),msg_type:"interactive",content:"frozen",uuid:"persisted-uuid"}).await,Outcome::Sent{message_id}if message_id=="om_card")
    );
    server.abort();
    let _ = server.await;
}
#[tokio::test]
async fn network_failure_is_ambiguous_and_errors_do_not_expose_credentials() {
    let s = Fixture::default();
    let app = Router::new()
        .route(
            "/open-apis/auth/v3/tenant_access_token/internal",
            post(token),
        )
        .route(
            "/open-apis/bot/v3/info/",
            get(|| async { Json(json!({"code":0,"bot":{"open_id":"ou_bot"}})) }),
        )
        .with_state(s);
    let (origin, server) = start(app).await;
    let client =
        Feishu::with_origin("app".into(), "secret-must-not-appear".into(), origin).unwrap();
    assert_eq!(client.bot_open_id().await.unwrap(), "ou_bot");
    server.abort();
    let _ = server.await;
    assert!(matches!(
        client
            .send(Outbound {
                kind: "article",
                chat_id: "oc_chat",
                reply_to: None,
                msg_type: "interactive",
                content: "frozen",
                uuid: "persisted-uuid"
            })
            .await,
        Outcome::Ambiguous { .. }
    ));
    assert_eq!(Unavailable.to_string(), "Feishu transport unavailable");
}
async fn events(mut ws: WebSocket, result: oneshot::Sender<Vec<i64>>) {
    let mut codes = vec![];
    for seq in 0..2 {
        let frame=Frame{seq_id:seq,log_id:0,service:1,method:1,headers:vec![Header{key:"type".into(),value:"event".into()},Header{key:"message_id".into(),value:"same-event".into()}],payload:Some(json!({"schema":"2.0","header":{"event_id":"same-event","event_type":"im.message.receive_v1"},"event":{"message":{"message_id":"om_1"}}}).to_string().into_bytes()),..Default::default()};
        ws.send(Message::Binary(frame.encode_to_vec().into()))
            .await
            .unwrap();
        while let Some(Ok(Message::Binary(bytes))) = ws.recv().await {
            let ack = Frame::decode(bytes.as_ref()).unwrap();
            if ack.method == 1 {
                let body: Value = serde_json::from_slice(ack.payload.as_deref().unwrap()).unwrap();
                codes.push(body["code"].as_i64().unwrap());
                break;
            }
        }
    }
    let _ = result.send(codes);
    let _ = ws.recv().await;
}
#[tokio::test]
async fn failed_durable_admission_is_not_acknowledged_as_success() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let app=Router::new().route("/callback/ws/endpoint",post(move||async move{Json(json!({"code":0,"data":{"URL":format!("ws://{addr}/ws?service_id=1&device_id=fixture"),"ClientConfig":{"PingInterval":60,"ReconnectInterval":1,"ReconnectCount":0,"ReconnectNonce":0}}}))})).route("/ws",get(move|upgrade:WebSocketUpgrade|{let sender=sender.clone();async move{let tx=sender.lock().await.take().unwrap();upgrade.on_upgrade(move|ws|events(ws,tx))}}));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client =
        Feishu::with_origin("app".into(), "secret".into(), format!("http://{addr}")).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut connection = client
        .websocket(move |event| {
            let calls = count.clone();
            async move {
                assert_eq!(event["message"]["message_id"], "om_1");
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(Unavailable)
                } else {
                    Ok(())
                }
            }
        })
        .unwrap();
    connection.connected().await.unwrap();
    let codes = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(codes, vec![500, 200]);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    connection.close().await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn sdk_max_retries_one_means_one_total_attempt() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let app = Router::new().route(
        "/single",
        get(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"code":99991400})),
                )
            }
        }),
    );
    let (origin, server) = start(app).await;
    let sdk = larksuite_oapi_sdk_rs::LarkClient::builder("app", "secret")
        .base_url(origin)
        .max_retries(1)
        .build()
        .unwrap();
    let request =
        larksuite_oapi_sdk_rs::req::ApiReq::new(larksuite_oapi_sdk_rs::HttpMethod::GET, "/single");
    assert!(
        sdk.raw_request(&request, &Default::default())
            .await
            .is_err()
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    server.abort();
    let _ = server.await;
}
