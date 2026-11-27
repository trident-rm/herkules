//! The Cloudflare objects behind a tunnel backend: a remotely managed tunnel, its ingress,
//! and a proxied CNAME.
//!
//! Every object the gateway creates carries its mark: tunnels are named `herkules-ai-<label>`
//! and DNS records hold the comment [`MARK`]. The gateway changes or deletes a tunnel or
//! record only after reading it back and finding that mark, and only DNS names of the form
//! `gpu-<8 hex>.<zone>`, so it never touches objects that Terraform or a person made.
//!
//! The API token needs Account › Cloudflare Tunnel › Edit and Zone › DNS › Edit on the zone.
//! Access needs no change per backend: the Terraform-managed application covers
//! `gpu-*.<zone>`.

use std::time::Duration;

use rand::{TryRng as _, rngs::SysRng};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::config::CloudflareConfig;

pub const MARK: &str = "managed by herkules-ai";
const TUNNEL_PREFIX: &str = "herkules-ai-";
const DEFAULT_BASE: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<Value>,
    result: Option<T>,
}

#[derive(Debug, Deserialize)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Record {
    id: String,
    name: String,
    #[serde(default)]
    comment: Option<String>,
}

/// What a new backend needs: the label, its hostname and its tunnel.
#[derive(Debug)]
pub struct Provisioned {
    pub hostname: String,
    pub tunnel_id: String,
    pub dns_record_id: String,
    /// Shown to the admin once, never stored.
    pub token: String,
}

pub struct Cloudflare {
    http: reqwest::Client,
    base: String,
    config: CloudflareConfig,
}

impl Cloudflare {
    pub fn new(http: reqwest::Client, config: CloudflareConfig) -> Self {
        Self {
            http,
            base: config
                .api_base
                .clone()
                .unwrap_or_else(|| DEFAULT_BASE.into())
                .trim_end_matches('/')
                .to_owned(),
            config,
        }
    }

    pub fn zone(&self) -> &str {
        &self.config.zone
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(&self.config.api_token)
            .timeout(Duration::from_secs(20));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| Error(format!("{method} {path}: {}", e.without_url())))?;
        let status = response.status();
        let envelope: Envelope<T> = response
            .json()
            .await
            .map_err(|e| Error(format!("{method} {path}: {status}: unreadable answer: {e}")))?;
        if !envelope.success || !status.is_success() {
            let messages: Vec<String> = envelope
                .errors
                .iter()
                .map(|e| e["message"].as_str().unwrap_or("error").to_owned())
                .collect();
            return Err(Error(format!(
                "{method} {path}: {status}: {}",
                messages.join("; ")
            )));
        }
        envelope
            .result
            .ok_or_else(|| Error(format!("{method} {path}: answer has no result")))
    }

    fn account(&self, rest: &str) -> String {
        format!("/accounts/{}/cfd_tunnel{rest}", self.config.account_id)
    }

    fn zone_records(&self, rest: &str) -> String {
        format!("/zones/{}/dns_records{rest}", self.config.zone_id)
    }

    /// A tunnel, refused unless it carries the mark.
    pub async fn tunnel(&self, id: &str) -> Result<Tunnel> {
        let tunnel: Tunnel = self
            .call(reqwest::Method::GET, &self.account(&format!("/{id}")), None)
            .await?;
        if !tunnel.name.starts_with(TUNNEL_PREFIX) {
            return Err(Error(format!(
                "tunnel {id} is not managed by the gateway; leaving it alone"
            )));
        }
        Ok(tunnel)
    }

    /// Creates the tunnel, its ingress to `http://localhost:<port>` and the CNAME, and
    /// fetches the connector token. A failure deletes what the earlier steps created.
    pub async fn provision(&self, port: u16) -> Result<Provisioned> {
        let label = label();
        let hostname = format!("{label}.{}", self.config.zone);
        let tunnel: Tunnel = self
            .call(
                reqwest::Method::POST,
                &self.account(""),
                Some(
                    json!({"name": format!("{TUNNEL_PREFIX}{label}"), "config_src": "cloudflare"}),
                ),
            )
            .await?;
        let rest = async {
            self.call::<Value>(
                reqwest::Method::PUT,
                &self.account(&format!("/{}/configurations", tunnel.id)),
                Some(json!({"config": {"ingress": [
                    {"hostname": hostname, "service": format!("http://localhost:{port}")},
                    {"service": "http_status:404"},
                ]}})),
            )
            .await?;
            let token: String = self
                .call(
                    reqwest::Method::GET,
                    &self.account(&format!("/{}/token", tunnel.id)),
                    None,
                )
                .await?;
            let record: Record = self
                .call(
                    reqwest::Method::POST,
                    &self.zone_records(""),
                    Some(json!({
                        "type": "CNAME",
                        "name": hostname,
                        "content": format!("{}.cfargotunnel.com", tunnel.id),
                        "proxied": true,
                        "comment": MARK,
                    })),
                )
                .await?;
            Ok::<_, Error>((token, record))
        }
        .await;
        match rest {
            Ok((token, record)) => Ok(Provisioned {
                hostname,
                tunnel_id: tunnel.id,
                dns_record_id: record.id,
                token,
            }),
            Err(e) => {
                if let Err(cleanup) = self.delete_tunnel(&tunnel.id).await {
                    tracing::error!("cleanup after failed provisioning: {cleanup}");
                }
                Err(e)
            }
        }
    }

    /// Deletes the CNAME, refused unless it carries the mark and a generated name.
    pub async fn delete_record(&self, id: &str) -> Result<()> {
        let path = self.zone_records(&format!("/{id}"));
        let record: Record = self.call(reqwest::Method::GET, &path, None).await?;
        let generated = record
            .name
            .strip_suffix(&format!(".{}", self.config.zone))
            .is_some_and(is_label);
        if record.comment.as_deref() != Some(MARK) || !generated {
            return Err(Error(format!(
                "DNS record {} is not managed by the gateway; leaving it alone",
                record.name
            )));
        }
        self.call::<Value>(reqwest::Method::DELETE, &path, None)
            .await
            .map(drop)
    }

    /// Deletes the tunnel. Cloudflare refuses while a connector is still attached.
    pub async fn delete_tunnel(&self, id: &str) -> Result<()> {
        self.tunnel(id).await?;
        self.call::<Value>(
            reqwest::Method::DELETE,
            &self.account(&format!("/{id}")),
            None,
        )
        .await
        .map(drop)
    }
}

/// `gpu-` and 8 random hex digits: one DNS label, so the zone's free certificate covers it.
fn label() -> String {
    let mut bytes = [0; 4];
    SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS entropy unavailable");
    format!("gpu-{}", hex::encode(bytes))
}

fn is_label(name: &str) -> bool {
    name.strip_prefix("gpu-").is_some_and(|rest| {
        rest.len() == 8
            && rest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}

/// The commands that install the connector on the GPU machine.
pub fn install_command(token: &str) -> String {
    format!("sudo cloudflared service install {token}")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, Method, StatusCode, Uri},
        routing::any,
    };

    use super::*;

    /// Recorded answer shapes from Cloudflare's API reference.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        records: Mutex<Vec<Value>>,
        fail_dns: bool,
    }

    async fn fake(
        State(fake): State<Arc<Fake>>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Option<Json<Value>>,
    ) -> (StatusCode, Json<Value>) {
        assert_eq!(headers["authorization"], "Bearer test-token");
        let path = uri.path().to_owned();
        fake.calls.lock().unwrap().push(format!("{method} {path}"));
        let ok = |result: Value| {
            (
                StatusCode::OK,
                Json(json!({"success": true, "errors": [], "messages": [], "result": result})),
            )
        };
        let tunnel = json!({"id": "f70ff985-a4ef-4643-bbbc-4a0ed4fc8415", "account_tag": "acc",
            "config_src": "cloudflare", "name": "herkules-ai-gpu-0a1b2c3d", "status": "inactive",
            "tun_type": "cfd_tunnel", "remote_config": true, "connections": []});
        match (method.as_str(), path.as_str()) {
            ("POST", "/accounts/acc/cfd_tunnel") => {
                let name = body.unwrap()["name"].as_str().unwrap().to_owned();
                assert!(name.starts_with("herkules-ai-gpu-"));
                let mut created = tunnel;
                created["name"] = json!(name);
                ok(created)
            }
            ("PUT", p) if p.ends_with("/configurations") => {
                let body = body.unwrap();
                let ingress = &body["config"]["ingress"];
                assert_eq!(ingress[0]["service"], "http://localhost:8000");
                assert_eq!(ingress[1]["service"], "http_status:404");
                ok(json!({"tunnel_id": "f70ff985", "version": 1, "config": body["config"]}))
            }
            ("GET", p) if p.ends_with("/token") => ok(json!("fake-tunnel-token")),
            ("GET", p) if p.starts_with("/accounts/acc/cfd_tunnel/") => {
                if p.ends_with("/foreign") {
                    ok(json!({"id": "foreign", "name": "someone-else", "status": "healthy"}))
                } else {
                    ok(tunnel)
                }
            }
            ("DELETE", p) if p.starts_with("/accounts/acc/cfd_tunnel/") => ok(tunnel),
            ("POST", "/zones/zone/dns_records") => {
                if fake.fail_dns {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"success": false, "errors": [{"code": 81053,
                            "message": "An A, AAAA, or CNAME record with that host already exists."}],
                            "messages": [], "result": null})),
                    );
                }
                let body = body.unwrap().0;
                assert_eq!(body["comment"], MARK);
                assert_eq!(body["proxied"], true);
                let record = json!({"id": "023e105f4ecef8ad9ca31a8372d0c353", "name": body["name"],
                    "type": "CNAME", "content": body["content"], "proxied": true, "ttl": 1,
                    "comment": body["comment"]});
                fake.records.lock().unwrap().push(record.clone());
                ok(record)
            }
            ("GET", p) if p.starts_with("/zones/zone/dns_records/") => {
                let id = p.rsplit('/').next().unwrap();
                match id {
                    "terraform" => ok(json!({"id": id, "name": "bbs.herkules.example",
                        "type": "A", "content": "192.0.2.1", "proxied": true})),
                    "marked-wrong-name" => ok(json!({"id": id, "name": "bbs.herkules.example",
                        "type": "CNAME", "comment": MARK})),
                    _ => ok(fake.records.lock().unwrap()[0].clone()),
                }
            }
            ("DELETE", p) if p.starts_with("/zones/zone/dns_records/") => {
                ok(json!({"id": p.rsplit('/').next().unwrap()}))
            }
            _ => (
                StatusCode::NOT_FOUND,
                Json(json!({"success": false, "errors": [], "result": null})),
            ),
        }
    }

    async fn client(fake_state: Arc<Fake>) -> Cloudflare {
        let app = Router::new()
            .route("/{*path}", any(fake))
            .with_state(fake_state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Cloudflare::new(
            reqwest::Client::new(),
            CloudflareConfig {
                api_token: "test-token".into(),
                account_id: "acc".into(),
                zone_id: "zone".into(),
                zone: "herkules.example".into(),
                access_client_id: "id".into(),
                access_client_secret: "secret".into(),
                api_base: Some(format!("http://{address}")),
            },
        )
    }

    #[tokio::test]
    async fn provisions_and_removes_a_backend() {
        let state = Arc::new(Fake::default());
        let cf = client(Arc::clone(&state)).await;
        let made = cf.provision(8000).await.unwrap();
        assert!(is_label(
            made.hostname.strip_suffix(".herkules.example").unwrap()
        ));
        assert_eq!(made.token, "fake-tunnel-token");
        assert_eq!(made.dns_record_id, "023e105f4ecef8ad9ca31a8372d0c353");
        let content = state.records.lock().unwrap()[0]["content"].clone();
        assert_eq!(content, format!("{}.cfargotunnel.com", made.tunnel_id));
        cf.delete_record(&made.dns_record_id).await.unwrap();
        cf.delete_tunnel(&made.tunnel_id).await.unwrap();
        let calls = state.calls.lock().unwrap().clone();
        assert_eq!(calls[0], "POST /accounts/acc/cfd_tunnel");
        assert!(
            calls
                .iter()
                .any(|c| c == "DELETE /zones/zone/dns_records/023e105f4ecef8ad9ca31a8372d0c353")
        );
        assert_eq!(
            calls.last().unwrap(),
            &format!("DELETE /accounts/acc/cfd_tunnel/{}", made.tunnel_id)
        );
    }

    #[tokio::test]
    async fn a_failed_step_deletes_the_new_tunnel() {
        let state = Arc::new(Fake {
            fail_dns: true,
            ..Fake::default()
        });
        let cf = client(Arc::clone(&state)).await;
        let error = cf.provision(8000).await.unwrap_err();
        assert!(error.0.contains("already exists"), "{error}");
        let calls = state.calls.lock().unwrap().clone();
        assert!(
            calls
                .last()
                .unwrap()
                .starts_with("DELETE /accounts/acc/cfd_tunnel/")
        );
    }

    #[tokio::test]
    async fn refuses_objects_without_the_mark() {
        let state = Arc::new(Fake::default());
        let cf = client(Arc::clone(&state)).await;
        for id in ["terraform", "marked-wrong-name"] {
            let error = cf.delete_record(id).await.unwrap_err();
            assert!(error.0.contains("not managed"), "{error}");
        }
        let error = cf.delete_tunnel("foreign").await.unwrap_err();
        assert!(error.0.contains("not managed"), "{error}");
        let calls = state.calls.lock().unwrap().clone();
        assert!(calls.iter().all(|c| !c.starts_with("DELETE")), "{calls:?}");
    }

    #[test]
    fn labels() {
        assert!(is_label(&label()));
        assert!(!is_label("gpu-0A1B2C3D"));
        assert!(!is_label("bbs"));
    }
}
