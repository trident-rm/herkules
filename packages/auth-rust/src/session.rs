//! First-party OAuth consumer. Wire-compatible with packages/oauth-client cookies.
use crate::auth::{Failure, Principal, Verifier, now_seconds};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    http::{HeaderMap, Method, header},
    response::{IntoResponse, Response},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use hkdf::Hkdf;
use rand::{TryRng, rngs::SysRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, oneshot};

#[derive(Clone)]
pub struct AuthConfig {
    /// Confidential OAuth client ID; also isolates encrypted cookies via HKDF salt.
    pub client_id: String,
    pub api_resource: String,
    pub mcp_resource: String,
    /// Local path receiving `login_error`; no query or fragment.
    pub login_error_path: String,
    pub public_origin: String,
    pub internal_origin: String,
    pub app_origin: String,
    pub client_secret: String,
    pub cookie_secret: String,
}
#[derive(Debug)]
pub enum AuthError {
    Config(&'static str),
    Http(reqwest::Error),
}
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(message) => f.write_str(message),
            Self::Http(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for AuthError {}
impl From<reqwest::Error> for AuthError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}
impl AuthConfig {
    /// Reject unsafe origins, ambiguous audiences, weak secrets and external error redirects.
    fn validate(&mut self) -> Result<(), AuthError> {
        for origin in [
            &mut self.public_origin,
            &mut self.internal_origin,
            &mut self.app_origin,
        ] {
            let url = url::Url::parse(origin)
                .map_err(|_| AuthError::Config("OAuth origins must be HTTP(S) origins"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(AuthError::Config(
                    "OAuth origins must have no credentials, path, query or fragment",
                ));
            }
            *origin = url.origin().ascii_serialization();
        }
        if self.client_id.is_empty() || self.client_id.chars().any(char::is_control) {
            return Err(AuthError::Config(
                "OAuth client ID must be nonempty and contain no controls",
            ));
        }
        if self.client_secret.encode_utf16().count() < 32
            || self.cookie_secret.encode_utf16().count() < 32
        {
            return Err(AuthError::Config(
                "OAuth client and cookie secrets must be at least 32 characters",
            ));
        }
        for resource in [&self.api_resource, &self.mcp_resource] {
            let url = url::Url::parse(resource)
                .map_err(|_| AuthError::Config("Resource audiences must be HTTP(S) URLs"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(AuthError::Config(
                    "Resource audiences must have no credentials, query or fragment",
                ));
            }
        }
        if safe_path(Some(&self.login_error_path)) != self.login_error_path
            || self.login_error_path.contains(['?', '#'])
        {
            return Err(AuthError::Config(
                "Login error path must be a local path without query or fragment",
            ));
        }
        if self.api_resource == self.mcp_resource {
            return Err(AuthError::Config("API and MCP audiences must be distinct"));
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Auth {
    pub verifier: Verifier,
    pub api_resource: String,
    pub mcp_resource: String,
    config: AuthConfig,
    client: reqwest::Client,
    jar: Jar,
    refreshes: Arc<Mutex<HashMap<String, RefreshEntry>>>,
}
enum RefreshEntry {
    Running(Instant, Shared<BoxFuture<'static, Grant>>),
    Done(Instant, Tokens),
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    state: String,
    code_verifier: String,
    next: String,
    issued_at: f64,
}
#[derive(Serialize, Deserialize)]
struct Login {
    attempts: Vec<Attempt>,
}
#[derive(Clone)]
struct Jar {
    session: Aes256Gcm,
    login: Aes256Gcm,
    secure: bool,
}
impl Jar {
    fn new(secret: &str, client_id: &str, secure: bool) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(client_id.as_bytes()), secret.as_bytes());
        let cipher = |purpose: &str| {
            let mut key = [0; 32];
            hk.expand(purpose.as_bytes(), &mut key).unwrap();
            Aes256Gcm::new_from_slice(&key).unwrap()
        };
        Self {
            session: cipher("session"),
            login: cipher("login"),
            secure,
        }
    }
    fn cipher(&self, purpose: &str) -> &Aes256Gcm {
        if purpose == "session" {
            &self.session
        } else {
            &self.login
        }
    }
    fn name(&self, purpose: &str) -> String {
        format!("{}hk_{purpose}", if self.secure { "__Host-" } else { "" })
    }
    fn raw<'a>(&self, headers: &'a HeaderMap, purpose: &str) -> Option<&'a str> {
        let prefix = format!("{}=", self.name(purpose));
        headers
            .get(header::COOKIE)?
            .to_str()
            .ok()?
            .split(';')
            .find_map(|s| s.trim().strip_prefix(&prefix))
            .filter(|s| !s.is_empty())
    }
    fn open<T: serde::de::DeserializeOwned>(&self, purpose: &str, raw: &str) -> Option<T> {
        let bytes = URL_SAFE_NO_PAD.decode(raw.strip_prefix("v1.")?).ok()?;
        if bytes.len() < 28 {
            return None;
        }
        let plain = self
            .cipher(purpose)
            .decrypt(
                &Nonce::try_from(&bytes[..12]).ok()?,
                Payload {
                    msg: &bytes[12..],
                    aad: purpose.as_bytes(),
                },
            )
            .ok()?;
        serde_json::from_slice(&plain).ok()
    }
    fn seal<T: Serialize>(&self, purpose: &str, value: &T) -> String {
        let mut iv = [0; 12];
        SysRng
            .try_fill_bytes(&mut iv)
            .expect("OS entropy unavailable");
        let plain = serde_json::to_vec(value).unwrap();
        let ct = self
            .cipher(purpose)
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: &plain,
                    aad: purpose.as_bytes(),
                },
            )
            .expect("bounded cookie encryption");
        let mut bytes = iv.to_vec();
        bytes.extend(ct);
        format!("v1.{}", URL_SAFE_NO_PAD.encode(bytes))
    }
    fn cookie(&self, purpose: &str, value: &str, age: u32) -> String {
        format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{}",
            self.name(purpose),
            if self.secure { "; Secure" } else { "" }
        )
    }
    fn write<T: Serialize>(&self, purpose: &str, value: &T) -> String {
        self.cookie(
            purpose,
            &self.seal(purpose, value),
            if purpose == "session" {
                30 * 24 * 3600
            } else {
                600
            },
        )
    }
    fn clear(&self, purpose: &str) -> String {
        self.cookie(purpose, "", 0)
    }
    fn attempts(&self, headers: &HeaderMap) -> Vec<Attempt> {
        self.raw(headers, "login")
            .and_then(|s| self.open::<Login>("login", s))
            .map(|l| {
                l.attempts
                    .into_iter()
                    .filter(|a| {
                        !a.state.is_empty()
                            && !a.code_verifier.is_empty()
                            && a.issued_at.is_finite()
                            && a.issued_at > now_seconds() * 1000.0 - 600_000.0
                    })
                    .take(3)
                    .collect()
            })
            .unwrap_or_default()
    }
}
#[derive(Clone)]
enum Grant {
    Tokens(Tokens),
    Rejected(String),
    ClientAuth,
    Unavailable,
}
pub struct Session {
    pub principal: Option<Principal>,
    pub failure: Option<Failure>,
    pub explicit: bool,
    pub cookies: Vec<String>,
}
impl Auth {
    /// Validate service configuration and construct shared verifier/refresh caches.
    /// Reuse one instance per service process; secrets are never included in Debug output.
    pub fn new(mut config: AuthConfig) -> Result<Self, AuthError> {
        config.validate()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        let verifier = Verifier::new(
            format!("{}/auth", config.public_origin),
            format!("{}/auth/jwks", config.internal_origin),
            client.clone(),
        );
        Ok(Self {
            verifier,
            api_resource: config.api_resource.clone(),
            mcp_resource: config.mcp_resource.clone(),
            jar: Jar::new(
                &config.cookie_secret,
                &config.client_id,
                config.app_origin.starts_with("https:"),
            ),
            config,
            client,
            refreshes: Default::default(),
        })
    }
    /// Resolve explicit bearer credentials before cookies and refresh eligible sessions.
    /// Callers must enforce explicit failures and append returned cookies on all paths.
    pub async fn resolve(&self, headers: &HeaderMap, method: &Method) -> Session {
        let session = |principal, failure, explicit, cookies| Session {
            principal,
            failure,
            explicit,
            cookies,
        };
        if headers.contains_key(header::AUTHORIZATION) {
            return match self.verifier.header(headers, &self.api_resource).await {
                Ok(p) => session(Some(p), None, true, vec![]),
                Err(e) => session(None, Some(e), true, vec![]),
            };
        }
        let Some(raw) = self.jar.raw(headers, "session") else {
            return session(None, Some(Failure::Missing), false, vec![]);
        };
        let Some(tokens) = self
            .jar
            .open::<Tokens>("session", raw)
            .filter(|t| !t.access_token.is_empty() && !t.refresh_token.is_empty())
        else {
            return session(
                None,
                Some(Failure::Missing),
                false,
                vec![self.jar.clear("session")],
            );
        };
        if !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
            && headers
                .get("sec-fetch-site")
                .is_some_and(|h| !h.as_bytes().eq_ignore_ascii_case(b"same-origin"))
        {
            return session(None, Some(Failure::Missing), false, vec![]);
        }
        let fallback = match self
            .verifier
            .verify(&tokens.access_token, &self.api_resource)
            .await
        {
            Ok(p) if p.expires_at - now_seconds() > 60.0 => {
                return session(Some(p), None, false, vec![]);
            }
            Ok(p) => Some(p),
            Err(Failure::Expired) => None,
            Err(Failure::Unavailable) => {
                return session(None, Some(Failure::Unavailable), false, vec![]);
            }
            Err(_) => {
                return session(
                    None,
                    Some(Failure::Missing),
                    false,
                    vec![self.jar.clear("session")],
                );
            }
        };
        match self.refresh(&tokens.refresh_token).await {
            Grant::Tokens(t) => {
                let cookies = vec![self.jar.write("session", &t)];
                match self
                    .verifier
                    .verify(&t.access_token, &self.api_resource)
                    .await
                {
                    Ok(p) => session(Some(p), None, false, cookies),
                    Err(_) => session(None, Some(Failure::Unavailable), false, cookies),
                }
            }
            Grant::Rejected(_) => session(
                None,
                Some(Failure::Missing),
                false,
                vec![self.jar.clear("session")],
            ),
            Grant::Unavailable if fallback.is_some() => session(fallback, None, false, vec![]),
            _ => session(None, Some(Failure::Unavailable), false, vec![]),
        }
    }
    fn basic(&self) -> String {
        format!(
            "Basic {}",
            STANDARD.encode(format!(
                "{}:{}",
                encode_component(&self.config.client_id),
                encode_component(&self.config.client_secret)
            ))
        )
    }
    async fn post(
        &self,
        endpoint: &str,
        form: &[(&str, &str)],
    ) -> Result<reqwest::Response, reqwest::Error> {
        self.client
            .post(format!(
                "{}/auth/oauth2/{endpoint}",
                self.config.internal_origin
            ))
            .header(header::AUTHORIZATION, self.basic())
            .header(header::ACCEPT, "application/json")
            .form(form)
            .send()
            .await
    }
    /// Classify token endpoint failures without logging credentials or response tokens.
    async fn grant(&self, form: &[(&str, &str)]) -> Grant {
        let Ok(r) = self.post("token", form).await else {
            return Grant::Unavailable;
        };
        let status = r.status();
        let Ok(v) = r.json::<Value>().await else {
            return Grant::Unavailable;
        };
        if status.is_success() {
            return match (v["access_token"].as_str(), v["refresh_token"].as_str()) {
                (Some(a), Some(r)) if !a.is_empty() && !r.is_empty() => Grant::Tokens(Tokens {
                    access_token: a.into(),
                    refresh_token: r.into(),
                }),
                _ => Grant::Unavailable,
            };
        }
        if status.as_u16() == 401 || v["error"] == "invalid_client" {
            return Grant::ClientAuth;
        }
        if status.is_client_error()
            && let Some(e) = v["error"].as_str()
        {
            return Grant::Rejected(e.into());
        }
        Grant::Unavailable
    }
    /// Run each refresh generation independently of HTTP request cancellation.
    /// A bounded owner publishes the result and cleans up only its own generation;
    /// waiters own a shared receiver, never the OAuth future or an Auth clone.
    async fn refresh(&self, token: &str) -> Grant {
        const DEADLINE: Duration = Duration::from_secs(10);
        let call = {
            let mut entries = self.refreshes.lock().await;
            entries.retain(|_, entry| match entry {
                RefreshEntry::Running(at, _) => at.elapsed() < DEADLINE,
                RefreshEntry::Done(at, _) => at.elapsed() < Duration::from_secs(30),
            });
            match entries.get(token) {
                Some(RefreshEntry::Done(_, tokens)) => return Grant::Tokens(tokens.clone()),
                Some(RefreshEntry::Running(_, call)) => call.clone(),
                None => {
                    let (sender, receiver) = oneshot::channel();
                    let call = async move { receiver.await.unwrap_or(Grant::Unavailable) }
                        .boxed()
                        .shared();
                    entries.insert(
                        token.to_owned(),
                        RefreshEntry::Running(Instant::now(), call.clone()),
                    );
                    let auth = self.clone();
                    let raw = token.to_owned();
                    let generation = call.clone();
                    tokio::spawn(async move {
                        let result = tokio::time::timeout(
                            DEADLINE,
                            auth.grant(&[("grant_type", "refresh_token"), ("refresh_token", &raw)]),
                        )
                        .await
                        .unwrap_or(Grant::Unavailable);
                        let mut entries = auth.refreshes.lock().await;
                        if matches!(entries.get(&raw), Some(RefreshEntry::Running(_, current)) if current.ptr_eq(&generation))
                        {
                            if let Grant::Tokens(tokens) = &result {
                                entries.insert(
                                    raw,
                                    RefreshEntry::Done(Instant::now(), tokens.clone()),
                                );
                            } else {
                                entries.remove(&raw);
                            }
                        }
                        let _ = sender.send(result);
                    });
                    call
                }
            }
        };
        call.await
    }
    /// Start confidential-client PKCE login and retain up to three sealed attempts.
    /// The optional `next` query value is restricted to a safe local path.
    pub fn login(&self, headers: &HeaderMap, q: &HashMap<String, String>) -> Response {
        let mut attempts = self.jar.attempts(headers);
        let random = || {
            let mut bytes = [0; 32];
            SysRng
                .try_fill_bytes(&mut bytes)
                .expect("OS entropy unavailable");
            URL_SAFE_NO_PAD.encode(bytes)
        };
        let attempt = Attempt {
            state: random(),
            code_verifier: random(),
            next: safe_path(q.get("next").map(String::as_str)),
            issued_at: now_seconds() * 1000.0,
        };
        let mut url = url::Url::parse(&format!(
            "{}/auth/oauth2/authorize",
            self.config.public_origin
        ))
        .unwrap();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", self.config.client_id.as_str()),
            (
                "redirect_uri",
                &format!("{}/callback", self.config.app_origin),
            ),
            ("resource", &self.api_resource),
            ("scope", "offline_access"),
            ("state", &attempt.state),
            (
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.code_verifier.as_bytes())),
            ),
            ("code_challenge_method", "S256"),
        ]);
        attempts.insert(0, attempt);
        attempts.truncate(3);
        redirect(
            url.as_str(),
            vec![self.jar.write("login", &Login { attempts })],
        )
    }
    /// Consume matching sealed state and exchange its code once using PKCE.
    /// Other pending attempts survive; success sets the compatible session cookie.
    pub async fn callback(&self, headers: &HeaderMap, q: &HashMap<String, String>) -> Response {
        let mut attempts = self.jar.attempts(headers);
        let Some(at) = attempts
            .iter()
            .position(|a| Some(&a.state) == q.get("state"))
        else {
            return self.login_failure("invalid_state", vec![]);
        };
        let attempt = attempts.remove(at);
        let login = if attempts.is_empty() {
            self.jar.clear("login")
        } else {
            self.jar.write("login", &Login { attempts })
        };
        if let Some(error) = q.get("error").filter(|s| !s.is_empty()) {
            return self.login_failure(error, vec![login]);
        }
        let Some(code) = q.get("code").filter(|s| !s.is_empty()) else {
            return self.login_failure("invalid_request", vec![login]);
        };
        let redirect_uri = format!("{}/callback", self.config.app_origin);
        match self
            .grant(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &redirect_uri),
                ("code_verifier", &attempt.code_verifier),
            ])
            .await
        {
            Grant::Tokens(t) => redirect(
                &safe_path(Some(&attempt.next)),
                vec![self.jar.write("session", &t), login],
            ),
            Grant::Rejected(e) => self.login_failure(&e, vec![login]),
            Grant::ClientAuth => {
                tracing::error!("OAuth client credentials refused");
                self.login_failure("client_auth", vec![login])
            }
            Grant::Unavailable => self.login_failure("unavailable", vec![login]),
        }
    }
    fn login_failure(&self, error: &str, cookies: Vec<String>) -> Response {
        redirect(
            &format!(
                "{}?login_error={}",
                self.config.login_error_path,
                encode_component(error)
            ),
            cookies,
        )
    }
    /// Clear both cookies and attempt issuer refresh-token revocation.
    /// The application must mount this handler only for POST requests.
    pub async fn logout(&self, headers: &HeaderMap, next: Option<&str>) -> Response {
        if let Some(tokens) = self
            .jar
            .raw(headers, "session")
            .and_then(|s| self.jar.open::<Tokens>("session", s))
        {
            let _ = self
                .post(
                    "revoke",
                    &[
                        ("token", &tokens.refresh_token),
                        ("token_type_hint", "refresh_token"),
                    ],
                )
                .await;
        }
        redirect(
            &safe_path(next),
            vec![self.jar.clear("session"), self.jar.clear("login")],
        )
    }
    /// Fetch Herkules user-info with the verified caller token, returning None
    /// on invalid data or issuer failure; application-specific fallback stays in the app.
    pub async fn user_profile(&self, p: &Principal) -> Option<Value> {
        let url = format!(
            "{}/auth/api/users/{}",
            self.config.internal_origin,
            encode_component(&p.subject)
        );
        async {
            let r = self
                .client
                .get(url)
                .bearer_auth(&p.token)
                .send()
                .await
                .ok()?;
            if !r.status().is_success() {
                return None;
            }
            let v = r.json::<Value>().await.ok()?;
            ["id", "displayName", "avatarUrl", "githubId"]
                .iter()
                .all(|k| v[k].is_string())
                .then_some(v)
        }
        .await
    }
}
/// Append all cookie updates, including multiple Set-Cookie values on errors.
pub fn with_cookies(mut r: Response, cookies: Vec<String>) -> Response {
    for c in cookies {
        r.headers_mut()
            .append(header::SET_COOKIE, c.parse().expect("sealed cookie header"));
    }
    r
}
fn redirect(location: &str, cookies: Vec<String>) -> Response {
    // Match Hono's encodeURI behavior for multibyte redirect destinations.
    let encoded = if location.chars().any(|c| c as u32 > 255) {
        location
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b";/?:@&=+$,#-_.!~*'()".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>()
    } else {
        location.to_owned()
    };
    let location = encoded.as_str();
    with_cookies(
        (
            axum::http::StatusCode::SEE_OTHER,
            [
                (header::LOCATION, location),
                (header::CACHE_CONTROL, "no-store"),
            ],
        )
            .into_response(),
        cookies,
    )
}
/// Restrict redirect destinations to bounded, control-free local paths; default to `/`.
pub fn safe_path(raw: Option<&str>) -> String {
    match raw {
        Some(s)
            if s.starts_with('/')
                && !s.starts_with("//")
                && !s.starts_with("/\\")
                && s.encode_utf16().count() <= 2048
                && !s.chars().any(|c| (c as u32) < 32 || c == '\u{7f}') =>
        {
            s.into()
        }
        _ => "/".into(),
    }
}
/// Encode UTF-8 using JavaScript encodeURIComponent semantics for OAuth interoperability.
pub fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sealing_and_redirect_boundaries() {
        let jar = Jar::new(&"x".repeat(32), "bbs", true);
        let tokens = Tokens {
            access_token: "a".into(),
            refresh_token: "r".into(),
        };
        let sealed = jar.seal("session", &tokens);
        assert_eq!(
            jar.open::<Tokens>("session", &sealed).unwrap().access_token,
            "a"
        );
        assert!(jar.open::<Tokens>("login", &sealed).is_none());
        assert!(
            Jar::new(&"x".repeat(32), "training", true)
                .open::<Tokens>("session", &sealed)
                .is_none()
        );
        assert!(
            Jar::new(&"y".repeat(32), "bbs", true)
                .open::<Tokens>("session", &sealed)
                .is_none()
        );
        for raw in ["//evil", "/\\evil", "https://evil", "/x\r\n"] {
            assert_eq!(safe_path(Some(raw)), "/")
        }
    }
    #[test]
    fn configurable_client_and_validation() {
        let config = AuthConfig {
            client_id: "training".into(),
            api_resource: "https://platform.example/api/training".into(),
            mcp_resource: "https://platform.example/mcp/training".into(),
            login_error_path: "/settings".into(),
            public_origin: "https://platform.example/".into(),
            internal_origin: "http://localhost:3001".into(),
            app_origin: "https://training.example".into(),
            client_secret: "c".repeat(32),
            cookie_secret: "s".repeat(32),
        };
        let auth = Auth::new(config.clone()).unwrap();
        let response = auth.login(&HeaderMap::new(), &HashMap::new());
        let url = url::Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], "training");
        assert_eq!(pairs["resource"], config.api_resource);
        assert_eq!(pairs["redirect_uri"], "https://training.example/callback");
        assert_eq!(
            auth.login_failure("test", vec![]).headers()[header::LOCATION],
            "/settings?login_error=test"
        );
        for variant in 0..5 {
            let mut invalid = config.clone();
            match variant {
                0 => invalid.client_id.clear(),
                1 => invalid.cookie_secret.clear(),
                2 => invalid.public_origin.push_str("path"),
                3 => invalid.mcp_resource = invalid.api_resource.clone(),
                _ => invalid.login_error_path = "//evil.example".into(),
            }
            assert!(Auth::new(invalid).is_err());
        }
    }
    /// Cancelling every HTTP waiter must not pause refresh or retain its state.
    #[tokio::test]
    async fn cancelled_refresh_waiters_still_complete_and_release_state() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (success, replaced) in [(false, false), (true, false), (true, true)] {
            let started = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Semaphore::new(0));
            let count = Arc::new(AtomicUsize::new(0));
            let app = axum::Router::new().route("/auth/oauth2/token", axum::routing::post({
                let started = started.clone();
                let release = release.clone();
                let count = count.clone();
                move || {
                    let started = started.clone();
                    let release = release.clone();
                    let count = count.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.acquire().await.unwrap().forget();
                        if success {
                            (axum::http::StatusCode::OK, axum::Json(json!({"access_token":"new-access", "refresh_token":"new-refresh"})))
                        } else {
                            (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error":"offline"})))
                        }
                    }
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let auth = Auth::new(AuthConfig {
                client_id: "test".into(),
                api_resource: format!("{origin}/api/test"),
                mcp_resource: format!("{origin}/mcp/test"),
                login_error_path: "/account".into(),
                public_origin: origin.clone(),
                internal_origin: origin,
                app_origin: "https://test.example".into(),
                client_secret: "c".repeat(32),
                cookie_secret: "s".repeat(32),
            })
            .unwrap();
            let weak = Arc::downgrade(&auth.refreshes);
            let waiters: Vec<_> = (0..10)
                .map(|_| {
                    let auth = auth.clone();
                    tokio::spawn(async move { auth.refresh("abandoned-token").await })
                })
                .collect();
            started.notified().await;
            for waiter in &waiters {
                waiter.abort();
            }
            for waiter in waiters {
                assert!(matches!(waiter.await, Err(error) if error.is_cancelled()));
            }
            if replaced {
                // A later generation must survive completion of this abandoned one.
                auth.refreshes.lock().await.insert(
                    "abandoned-token".into(),
                    RefreshEntry::Done(
                        Instant::now(),
                        Tokens {
                            access_token: "later-access".into(),
                            refresh_token: "later-refresh".into(),
                        },
                    ),
                );
            }
            release.add_permits(1);
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let entries = auth.refreshes.lock().await;
                    if Arc::strong_count(&auth.refreshes) == 1
                        && !matches!(
                            entries.get("abandoned-token"),
                            Some(RefreshEntry::Running(_, _))
                        )
                    {
                        break;
                    }
                    drop(entries);
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if success {
                assert!(
                    matches!(auth.refresh("abandoned-token").await, Grant::Tokens(tokens) if tokens.refresh_token == if replaced { "later-refresh" } else { "new-refresh" })
                );
            } else {
                assert!(auth.refreshes.lock().await.is_empty());
            }
            assert_eq!(count.load(Ordering::SeqCst), 1);
            drop(auth);
            tokio::time::timeout(Duration::from_secs(2), async {
                while weak.upgrade().is_some() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            server.abort();
        }
    }
    #[tokio::test]
    async fn failed_refresh_is_single_flight_but_not_memoized() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let app = axum::Router::new().route(
            "/auth/oauth2/token",
            axum::routing::post(move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        axum::Json(json!({"error":"offline"})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let auth = Auth::new(AuthConfig {
            client_id: "bbs".into(),
            api_resource: format!("{origin}/api/bbs"),
            mcp_resource: format!("{origin}/mcp/bbs"),
            login_error_path: "/account".into(),
            public_origin: origin.clone(),
            internal_origin: origin,
            app_origin: "https://bbs.example".into(),
            client_secret: "test".repeat(8),
            cookie_secret: "x".repeat(32),
        })
        .unwrap();
        let futures = (0..10).map(|_| auth.refresh("same-token"));
        for result in futures_util::future::join_all(futures).await {
            assert!(matches!(result, Grant::Unavailable));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(matches!(
            auth.refresh("same-token").await,
            Grant::Unavailable
        ));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(auth.refreshes.lock().await.is_empty());
        server.abort();
    }
}
