//! Feishu transport for Herkules applications. Product policy and durable retries belong to callers.
use larksuite_oapi_sdk_rs::{EventDispatcher, LarkClient, LarkError};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, watch};
pub const ORIGIN: &str = "https://open.feishu.cn";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Sent {
        message_id: String,
    },
    NotSent {
        code: String,
        retry_after_ms: Option<i64>,
    },
    Ambiguous {
        code: String,
        retry_after_ms: Option<i64>,
    },
    Permanent {
        code: String,
        fatal: bool,
    },
}
pub struct Outbound<'a> {
    pub kind: &'a str,
    pub chat_id: &'a str,
    pub reply_to: Option<&'a str>,
    pub msg_type: &'a str,
    pub content: &'a str,
    pub uuid: &'a str,
}
#[derive(Clone)]
pub struct Feishu {
    http: Client,
    origin: String,
    app_id: String,
    secret: String,
    token: Arc<Mutex<Option<(String, Instant)>>>,
}
#[derive(Debug)]
pub struct Unavailable;
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Feishu transport unavailable")
    }
}
impl std::error::Error for Unavailable {}
impl Feishu {
    pub fn new(app_id: String, secret: String) -> Result<Self, Unavailable> {
        Self::with_origin(app_id, secret, ORIGIN.into())
    }
    // Explicit origin supports loopback fixture servers; product configuration uses the fixed Feishu origin.
    pub fn with_origin(
        app_id: String,
        secret: String,
        origin: String,
    ) -> Result<Self, Unavailable> {
        let url = url::Url::parse(&origin).map_err(|_| Unavailable)?;
        if app_id.is_empty()
            || secret.is_empty()
            || !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(Unavailable);
        }
        let http = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| Unavailable)?;
        Ok(Self {
            http,
            origin: origin.trim_end_matches('/').into(),
            app_id,
            secret,
            token: Arc::new(Mutex::new(None)),
        })
    }
    async fn token(&self) -> Result<String, Outcome> {
        let mut cache = self.token.lock().await;
        if let Some((token, expires)) = cache.as_ref().filter(|(_, at)| *at > Instant::now()) {
            let _ = expires;
            return Ok(token.clone());
        }
        let response = self
            .http
            .post(format!(
                "{}/open-apis/auth/v3/tenant_access_token/internal",
                self.origin
            ))
            .json(&json!({"app_id":self.app_id,"app_secret":self.secret}))
            .send()
            .await
            .map_err(|_| token_unavailable())?;
        if !response.status().is_success() {
            return Err(classify_http(
                response.status().as_u16(),
                "token_unavailable".into(),
                None,
            ));
        }
        let v = bounded_json(response)
            .await
            .map_err(|_| token_unavailable())?;
        if v["code"].as_i64() != Some(0) {
            return Err(token_unavailable());
        }
        let token = v["tenant_access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(token_unavailable)?
            .to_string();
        let expires = v["expire"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(token_unavailable)?;
        *cache = Some((
            token.clone(),
            Instant::now() + Duration::from_secs(expires.saturating_sub(60).min(86400)),
        ));
        Ok(token)
    }
    pub async fn bot_open_id(&self) -> Result<String, Unavailable> {
        let token = self.token().await.map_err(|_| Unavailable)?;
        let response = self
            .http
            .get(format!("{}/open-apis/bot/v3/info/", self.origin))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Unavailable)?;
        if !response.status().is_success() {
            return Err(Unavailable);
        }
        let v = bounded_json(response).await?;
        if v["code"].as_i64() != Some(0) {
            return Err(Unavailable);
        }
        v["bot"]["open_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or(Unavailable)
    }
    pub async fn send(&self, e: Outbound<'_>) -> Outcome {
        let token = match self.token().await {
            Ok(t) => t,
            Err(outcome) => return outcome,
        };
        let (method, path, body) = if e.kind == "update" {
            let Some(reply) = e.reply_to else {
                return Outcome::Permanent {
                    code: "missing_card_message_id".into(),
                    fatal: false,
                };
            };
            (
                Method::PATCH,
                format!("/open-apis/im/v1/messages/{}", segment(reply)),
                json!({"content":e.content}),
            )
        } else if let Some(reply) = e.reply_to {
            (
                Method::POST,
                format!("/open-apis/im/v1/messages/{}/reply", segment(reply)),
                json!({"msg_type":e.msg_type,"content":e.content,"uuid":e.uuid}),
            )
        } else {
            (
                Method::POST,
                format!(
                    "/open-apis/im/v1/messages?receive_id_type={}",
                    if e.chat_id.starts_with("ou_") {
                        "open_id"
                    } else {
                        "chat_id"
                    }
                ),
                json!({"receive_id":e.chat_id,"msg_type":e.msg_type,"content":e.content,"uuid":e.uuid}),
            )
        };
        let response = match self
            .http
            .request(method, format!("{}{path}", self.origin))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => {
                return Outcome::Ambiguous {
                    code: "transport_error".into(),
                    retry_after_ms: None,
                };
            }
        };
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| (n * 1000.0).min(86400000.0) as i64);
        let body = bounded_json(response).await;
        let v = match body {
            Ok(v) => v,
            Err(_) => {
                return if !(200..300).contains(&status) {
                    classify_http(status, "transport_error".into(), retry)
                } else {
                    Outcome::Ambiguous {
                        code: "invalid_response".into(),
                        retry_after_ms: None,
                    }
                };
            }
        };
        let code = v["code"].as_i64();
        if !(200..300).contains(&status) {
            return classify_http(
                status,
                code.map(|c| c.to_string())
                    .unwrap_or_else(|| "transport_error".into()),
                retry,
            );
        }
        if let Some(code) = code.filter(|n| *n != 0) {
            return classify_code(code);
        }
        if code != Some(0) {
            return Outcome::Ambiguous {
                code: "invalid_response".into(),
                retry_after_ms: None,
            };
        }
        if e.kind == "update" {
            return Outcome::Sent {
                message_id: e.reply_to.unwrap_or_default().into(),
            };
        }
        match v["data"]["message_id"].as_str().filter(|s| !s.is_empty()) {
            Some(id) => Outcome::Sent {
                message_id: id.into(),
            },
            None => Outcome::Ambiguous {
                code: "missing_message_id".into(),
                retry_after_ms: None,
            },
        }
    }
    pub fn websocket<F, Fut>(&self, handler: F) -> Result<Connection, Unavailable>
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), Unavailable>> + Send + 'static,
    {
        let handler = Arc::new(handler);
        let on_message = handler.clone();
        let on_menu = handler.clone();
        let on_card = handler;
        let dispatcher = EventDispatcher::new("", "")
            .on_event("im.message.receive_v1", move |value| {
                let handler = on_message.clone();
                async move {
                    handler(value.into_value())
                        .await
                        .map_err(|_| LarkError::Event("durable receipt unavailable".into()))
                }
            })
            .on_event("application.bot.menu_v6", move |value| {
                let handler = on_menu.clone();
                async move {
                    handler(value.into_value())
                        .await
                        .map_err(|_| LarkError::Event("durable receipt unavailable".into()))
                }
            })
            .on_callback("card.action.trigger", move |value| {
                let handler = on_card.clone();
                async move {
                    handler(value.into_value())
                        .await
                        .map_err(|_| LarkError::Event("durable receipt unavailable".into()))?;
                    Ok(larksuite_oapi_sdk_rs::JsonValue::from(json!({})))
                }
            });
        let client = LarkClient::builder(&self.app_id, &self.secret)
            .base_url(&self.origin)
            .timeout(Duration::from_secs(15))
            .max_retries(1)
            .build()
            .map_err(|_| Unavailable)?;
        let (ready_tx, ready) = watch::channel(false);
        let tx = ready_tx.clone();
        let reconnected = ready_tx.clone();
        let ws = client
            .ws_client(dispatcher)
            .write_timeout(Duration::from_secs(5))
            .websocket_connector(|url| async move {
                let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(1024 * 1024))
                    .max_frame_size(Some(1024 * 1024));
                tokio::time::timeout(
                    Duration::from_secs(15),
                    tokio_tungstenite::connect_async_with_config(url, Some(config), false),
                )
                .await
                .map_err(|_| {
                    tokio_tungstenite::tungstenite::Error::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "WebSocket dial timeout",
                    ))
                })?
                .map_err(|_| {
                    tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(
                        "WebSocket dial failed",
                    ))
                })
            })
            .on_ready(move || {
                let _ = tx.send(true);
            })
            .on_reconnected(move || {
                let _ = reconnected.send(true);
            })
            .on_disconnected(move || {
                let _ = ready_tx.send(false);
            });
        let control = ws.control();
        let task = tokio::spawn(async move { ws.start().await.map_err(|_| Unavailable) });
        Ok(Connection {
            ready,
            control,
            task,
        })
    }
}
fn segment(value: &str) -> String {
    url::Url::parse("https://placeholder.invalid")
        .map(|mut u| {
            u.path_segments_mut().unwrap().push(value);
            u.path().trim_start_matches('/').to_string()
        })
        .unwrap_or_default()
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value, Unavailable> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Unavailable)? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(Unavailable);
        }
        bytes.extend_from_slice(&chunk)
    }
    serde_json::from_slice(&bytes).map_err(|_| Unavailable)
}
pub fn classify_http(status: u16, code: String, retry: Option<i64>) -> Outcome {
    if code == "99991400" && status != 401 && status != 403 {
        return Outcome::NotSent {
            code,
            retry_after_ms: retry,
        };
    }
    match status {
        401 | 403 => Outcome::Permanent { code, fatal: true },
        429 => Outcome::NotSent {
            code,
            retry_after_ms: retry,
        },
        400 | 404 => Outcome::Permanent { code, fatal: false },
        _ => Outcome::NotSent {
            code,
            retry_after_ms: None,
        },
    }
}
pub fn classify_code(code: i64) -> Outcome {
    if [230001, 230002, 230017, 230020].contains(&code) {
        Outcome::Permanent {
            code: code.to_string(),
            fatal: false,
        }
    } else {
        Outcome::NotSent {
            code: code.to_string(),
            retry_after_ms: None,
        }
    }
}
fn token_unavailable() -> Outcome {
    Outcome::NotSent {
        code: "token_unavailable".into(),
        retry_after_ms: None,
    }
}

pub struct Connection {
    pub ready: watch::Receiver<bool>,
    control: larksuite_oapi_sdk_rs::ws::WsClientControl,
    pub task: tokio::task::JoinHandle<Result<(), Unavailable>>,
}
impl Connection {
    pub async fn connected(&mut self) -> Result<(), Unavailable> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if *self.ready.borrow() {
                    return Ok(());
                }
                self.ready.changed().await.map_err(|_| Unavailable)?
            }
        })
        .await
        .map_err(|_| Unavailable)?
    }
    pub async fn close(&mut self) {
        self.control.close();
        if tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}
