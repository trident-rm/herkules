//! Resource-server verification implementing docs/tokens.md, shared by API and MCP.
//! No token or credential is included in Debug output or logs.
use axum::{
    Json,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Principal {
    pub subject: String,
    pub role: String,
    pub expires_at: f64,
    pub issued_at: f64,
    pub client_id: String,
    pub resource: String,
    pub scopes: std::collections::BTreeSet<String>,
    pub token_id: String,
    pub session_id: Option<String>,
    pub claims: Value,
    pub token: String,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Failure {
    Missing,
    Header,
    Invalid,
    Expired,
    Unavailable,
}
impl Failure {
    pub fn response(self, resource: &str, mcp: bool) -> Response {
        let (status, code, message) = match self {
            Self::Missing => (
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "missing bearer token",
            ),
            Self::Header => (
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "invalid authorization header",
            ),
            Self::Invalid => (StatusCode::UNAUTHORIZED, "invalid_token", "invalid token"),
            Self::Expired => (StatusCode::UNAUTHORIZED, "invalid_token", "token expired"),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "authorization keys unavailable, retry",
            ),
        };
        let body = if mcp {
            json!({"jsonrpc":"2.0","error":{"code":-32000,"message":message},"id":null})
        } else {
            json!({"error":code,"error_description":message})
        };
        let mut response = (status, Json(body)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        if self == Self::Unavailable {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "5".parse().unwrap());
        } else {
            let url = url::Url::parse(resource).expect("validated resource origin");
            let metadata = format!(
                "{}/.well-known/oauth-protected-resource{}",
                url.origin().ascii_serialization(),
                url.path()
            );
            let challenge = if self == Self::Missing {
                format!("Bearer resource_metadata=\"{metadata}\"")
            } else {
                format!(
                    "Bearer error=\"invalid_token\", resource_metadata=\"{metadata}\", error_description=\"{message}\""
                )
            };
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, challenge.parse().unwrap());
        }
        response
    }
}
#[derive(Default)]
struct Keys {
    values: HashMap<String, Vec<VerifyingKey>>,
    loaded: Option<Instant>,
    attempted: Option<Instant>,
}
#[derive(Clone)]
pub struct Verifier {
    issuer: String,
    jwks: String,
    client: reqwest::Client,
    keys: Arc<Mutex<Keys>>,
}
impl Verifier {
    pub fn new(issuer: String, jwks: String, client: reqwest::Client) -> Self {
        Self {
            issuer,
            jwks,
            client,
            keys: Arc::new(Mutex::new(Keys::default())),
        }
    }
    pub async fn header(&self, headers: &HeaderMap, resource: &str) -> Result<Principal, Failure> {
        let raw = headers
            .get(header::AUTHORIZATION)
            .map(|v| v.to_str().map_err(|_| Failure::Header))
            .transpose()?;
        self.verify(parse_authorization(raw)?, resource).await
    }
    pub async fn verify(&self, token: &str, resource: &str) -> Result<Principal, Failure> {
        let parts: Vec<_> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(Failure::Invalid);
        }
        let h = decode_json(parts[0])?;
        let typ = h["typ"].as_str().unwrap_or("").to_ascii_lowercase();
        let typ = typ.strip_prefix("application/").unwrap_or(&typ);
        let kid = nonempty(&h["kid"])?;
        if h["alg"] != "EdDSA"
            || typ != "at+jwt"
            || h.get("crit").is_some()
            || h.get("b64").is_some_and(|v| v != true)
        {
            return Err(Failure::Invalid);
        }
        let key = self.key(kid).await?;
        let bytes = URL_SAFE_NO_PAD
            .decode(parts[2])
            .map_err(|_| Failure::Invalid)?;
        let signature = Signature::from_slice(&bytes).map_err(|_| Failure::Invalid)?;
        key.verify_strict(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .map_err(|_| Failure::Invalid)?;
        claims_principal(
            decode_json(parts[1])?,
            token,
            &self.issuer,
            resource,
            now_seconds(),
        )
    }
    async fn key(&self, kid: &str) -> Result<VerifyingKey, Failure> {
        let mut cache = self.keys.lock().await;
        let fresh = cache
            .loaded
            .is_some_and(|t| t.elapsed() < Duration::from_secs(300));
        let known = cache.values.contains_key(kid);
        let cooldown = cache
            .attempted
            .is_some_and(|t| t.elapsed() < Duration::from_secs(30));
        if (!fresh || !known) && !cooldown {
            cache.attempted = Some(Instant::now());
            let fetched = async {
                let response = self.client.get(&self.jwks).send().await.ok()?;
                if response.status() != reqwest::StatusCode::OK {
                    return None;
                }
                let body: Value = response.json().await.ok()?;
                parse_keys(&body)
            }
            .await;
            if let Some(values) = fetched {
                cache.values = values;
                cache.loaded = Some(Instant::now());
            } else if cache.loaded.is_none() {
                return Err(Failure::Unavailable);
            }
        }
        if cache.loaded.is_none() {
            return Err(Failure::Unavailable);
        }
        let matches = cache.values.get(kid).ok_or(Failure::Invalid)?;
        if matches.len() != 1 {
            return Err(Failure::Invalid);
        }
        Ok(matches[0])
    }
}
fn parse_keys(body: &Value) -> Option<HashMap<String, Vec<VerifyingKey>>> {
    let mut out: HashMap<String, Vec<VerifyingKey>> = HashMap::new();
    for k in body.get("keys")?.as_array()? {
        if k["kty"] != "OKP"
            || k["crv"] != "Ed25519"
            || k.get("alg").is_some_and(|v| v != "EdDSA")
            || k.get("use").is_some_and(|v| v != "sig")
            || k.get("key_ops").is_some_and(|v| {
                v.as_array()
                    .is_none_or(|a| !a.iter().any(|v| v == "verify"))
            })
        {
            continue;
        }
        let Some(kid) = k["kid"].as_str() else {
            continue;
        };
        let Some(bytes) = k["x"]
            .as_str()
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .and_then(|v| <[u8; 32]>::try_from(v).ok())
        else {
            continue;
        };
        if let Ok(key) = VerifyingKey::from_bytes(&bytes) {
            out.entry(kid.into()).or_default().push(key);
        }
    }
    Some(out)
}
fn decode_json(raw: &str) -> Result<Value, Failure> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(raw).map_err(|_| Failure::Invalid)?)
        .map_err(|_| Failure::Invalid)
}
fn nonempty(v: &Value) -> Result<&str, Failure> {
    v.as_str().filter(|s| !s.is_empty()).ok_or(Failure::Invalid)
}
pub fn now_seconds() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64 / 1000.0
}
fn claims_principal(
    c: Value,
    token: &str,
    issuer: &str,
    resource: &str,
    now: f64,
) -> Result<Principal, Failure> {
    if c["iss"] != issuer
        || !(c["aud"] == resource
            || c["aud"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == resource)))
    {
        return Err(Failure::Invalid);
    }
    let exp = c["exp"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or(Failure::Invalid)?;
    let iat = c["iat"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or(Failure::Invalid)?;
    if exp <= now - 60.0 {
        return Err(Failure::Expired);
    }
    if iat > now + 60.0
        || c.get("nbf")
            .is_some_and(|v| v.as_f64().is_none_or(|n| n > now + 60.0))
    {
        return Err(Failure::Invalid);
    }
    let subject = nonempty(&c["sub"])?;
    let client_id = nonempty(
        c.get("client_id")
            .filter(|v| !v.is_null())
            .unwrap_or(&c["azp"]),
    )?;
    let token_id = nonempty(&c["jti"])?;
    let role = nonempty(&c["role"])?;
    if !matches!(role, "admin" | "member")
        || c.get("cnf").is_some()
        || c.get("sid").is_some_and(|v| !v.is_string())
    {
        return Err(Failure::Invalid);
    }
    if let Some(scope) = c.get("scope") {
        let scope = scope.as_str().ok_or(Failure::Invalid)?;
        if !scope.is_empty()
            && scope.split(' ').any(|s| {
                s.is_empty()
                    || !s.bytes().all(|b| {
                        b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b)
                    })
            })
        {
            return Err(Failure::Invalid);
        }
    }
    Ok(Principal {
        subject: subject.into(),
        role: role.into(),
        expires_at: exp,
        token: token.into(),
        issued_at: iat,
        client_id: client_id.into(),
        resource: resource.into(),
        token_id: token_id.into(),
        scopes: c["scope"]
            .as_str()
            .unwrap_or("")
            .split(' ')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        session_id: c["sid"].as_str().map(str::to_owned),
        claims: c.clone(),
    })
}
pub fn parse_authorization(raw: Option<&str>) -> Result<&str, Failure> {
    let raw = raw.unwrap_or("").trim();
    if raw.is_empty() {
        return Err(Failure::Missing);
    }
    let Some(at) = raw.find(char::is_whitespace) else {
        return Err(Failure::Header);
    };
    let token = raw[at..].trim();
    if !raw[..at].eq_ignore_ascii_case("bearer")
        || token.is_empty()
        || token.chars().any(char::is_whitespace)
    {
        return Err(Failure::Header);
    }
    Ok(token)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn normative_vectors() {
        let v: Value =
            serde_json::from_str(include_str!("../../../../docs/tokens-vectors.json")).unwrap();
        let client = reqwest::Client::new();
        let verifier = Verifier::new(
            v["issuer"].as_str().unwrap().into(),
            "http://127.0.0.1:1/unused".into(),
            client,
        );
        {
            let mut cache = verifier.keys.lock().await;
            cache.values = parse_keys(&v["jwks"]).unwrap();
            cache.loaded = Some(Instant::now());
            cache.attempted = Some(Instant::now());
        }
        for vector in v["vectors"].as_array().unwrap() {
            let resource = v["resource"].as_str().unwrap();
            let result = match vector["token"].as_str() {
                Some(token) => verifier.verify(token, resource).await,
                None => Err(Failure::Missing),
            };
            let status = result
                .as_ref()
                .map(|_| 200)
                .unwrap_or_else(|f| f.response(resource, true).status().as_u16());
            assert_eq!(
                status,
                vector["expect"]["status"].as_u64().unwrap() as u16,
                "{}",
                vector["name"]
            );
            if let Ok(p) = &result {
                assert_eq!(p.subject, vector["expect"]["principal"]["sub"]);
                assert_eq!(p.role, vector["expect"]["principal"]["role"]);
                assert_eq!(p.client_id, vector["expect"]["principal"]["client_id"]);
                assert_eq!(p.token_id, vector["expect"]["principal"]["jti"]);
            }
            if let Err(f) = result {
                assert_eq!(
                    f.response(resource, true)
                        .headers()
                        .get(header::WWW_AUTHENTICATE)
                        .and_then(|h| h.to_str().ok()),
                    vector["expect"]["www_authenticate"].as_str(),
                    "{}",
                    vector["name"]
                );
            }
        }
    }
    #[tokio::test]
    async fn jwks_cache_cooldown_and_outage() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let vectors: Value =
            serde_json::from_str(include_str!("../../../../docs/tokens-vectors.json")).unwrap();
        let jwks = vectors["jwks"].clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let offline = Arc::new(AtomicBool::new(false));
        let c = calls.clone();
        let o = offline.clone();
        let app = axum::Router::new().route(
            "/jwks",
            axum::routing::get(move || {
                let c = c.clone();
                let o = o.clone();
                let jwks = jwks.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    if o.load(Ordering::SeqCst) {
                        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response()
                    } else {
                        Json(jwks).into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/jwks", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let verifier = Verifier::new(
            vectors["issuer"].as_str().unwrap().into(),
            url.clone(),
            client.clone(),
        );
        let resource = vectors["resource"].as_str().unwrap();
        let valid = vectors["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "valid")
            .unwrap()["token"]
            .as_str()
            .unwrap();
        assert!(matches!(
            verifier.verify("junk", resource).await,
            Err(Failure::Invalid)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(verifier.verify(valid, resource).await.is_ok());
        assert!(verifier.verify(valid, resource).await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let unknown = vectors["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "unknown_kid")
            .unwrap()["token"]
            .as_str()
            .unwrap();
        assert!(matches!(
            verifier.verify(unknown, resource).await,
            Err(Failure::Invalid)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        {
            let mut k = verifier.keys.lock().await;
            k.attempted = Some(Instant::now() - Duration::from_secs(31));
        }
        assert!(matches!(
            verifier.verify(unknown, resource).await,
            Err(Failure::Invalid)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        offline.store(true, Ordering::SeqCst);
        {
            let mut k = verifier.keys.lock().await;
            k.loaded = Some(Instant::now() - Duration::from_secs(301));
            k.attempted = Some(Instant::now() - Duration::from_secs(31));
        }
        assert!(
            verifier.verify(valid, resource).await.is_ok(),
            "stale key fallback"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let fresh = Verifier::new(vectors["issuer"].as_str().unwrap().into(), url, client);
        assert!(matches!(
            fresh.verify(valid, resource).await,
            Err(Failure::Unavailable)
        ));
        let response = Failure::Unavailable.response(resource, true);
        assert_eq!(response.status(), 503);
        assert_eq!(response.headers()[header::RETRY_AFTER], "5");
        assert!(!response.headers().contains_key(header::WWW_AUTHENTICATE));
        server.abort();
    }
}
