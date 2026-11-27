//! The environment boundary: every setting the gateway reads, validated at startup.

use std::{env, fs, net::SocketAddr, path::PathBuf};

use herkules_auth::session::AuthConfig;
use serde::Deserialize;
use url::Url;

use crate::backends::{Backend, Credential, Source};

pub struct Config {
    pub listen: SocketAddr,
    pub database_url: String,
    pub db_connections: u32,
    /// `https://ai-api.herkules.dev`: requests for this host go to the API.
    pub api_origin: String,
    /// `https://ai-portal.herkules.dev`: requests for this host go to the portal.
    pub portal_origin: String,
    pub auth: AuthConfig,
    /// The auth service's private membership endpoint and its credential.
    pub membership_url: String,
    pub sync_secret: String,
    pub web_dir: Option<PathBuf>,
    pub backends: Vec<Backend>,
    pub cloudflare: Option<CloudflareConfig>,
    pub max_request_bytes: usize,
    pub log_body_bytes: usize,
    pub log_retention_days: i32,
    /// A backend response that sends no byte for this long fails.
    pub upstream_idle: std::time::Duration,
}

/// The Cloudflare account the gateway creates tunnels in, from a server-owned file.
#[derive(Clone, Deserialize)]
pub struct CloudflareConfig {
    pub api_token: String,
    pub account_id: String,
    pub zone_id: String,
    /// `herkules.dev`: backend hostnames are `gpu-<id>.<zone>`.
    pub zone: String,
    /// The Access service token the gateway presents to every tunnel backend.
    pub access_client_id: String,
    pub access_client_secret: String,
    /// Overrides `https://api.cloudflare.com/client/v4` in tests.
    #[serde(default)]
    pub api_base: Option<String>,
}

impl std::fmt::Debug for CloudflareConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudflareConfig")
            .field("account_id", &self.account_id)
            .field("zone", &self.zone)
            .finish_non_exhaustive()
    }
}

/// One entry of `AI_BACKENDS_FILE`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackendEntry {
    name: String,
    url: String,
    models: Vec<String>,
    /// A JSON file holding `{"bearer": …}` or `{"cf_access_client_id": …, "cf_access_client_secret": …}`.
    #[serde(default)]
    credentials: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialFile {
    bearer: Option<String>,
    cf_access_client_id: Option<String>,
    cf_access_client_secret: Option<String>,
}

fn var(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

fn number<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match env::var(name) {
        Ok(raw) => raw
            .parse()
            .map_err(|_| format!("{name} must be a positive integer")),
        Err(_) => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url = var("DATABASE_URL")?;
        if !matches!(
            Url::parse(&database_url)
                .map(|u| u.scheme().to_owned())
                .as_deref(),
            Ok("postgres" | "postgresql")
        ) {
            return Err("DATABASE_URL must be a postgres:// URL".into());
        }
        let listen = env::var("AI_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:4010".into())
            .parse()
            .map_err(|_| "AI_LISTEN must be an IP address and port")?;
        let public_origin = origin("PUBLIC_ORIGIN", &var("PUBLIC_ORIGIN")?)?;
        let internal_origin = origin(
            "AUTH_INTERNAL_URL",
            &env::var("AUTH_INTERNAL_URL").unwrap_or_else(|_| public_origin.clone()),
        )?;
        let api_origin = origin("AI_API_ORIGIN", &var("AI_API_ORIGIN")?)?;
        let portal_origin = origin("AI_PORTAL_ORIGIN", &var("AI_PORTAL_ORIGIN")?)?;
        if host_of(&api_origin) == host_of(&portal_origin) {
            return Err("AI_API_ORIGIN and AI_PORTAL_ORIGIN must have different hosts".into());
        }
        let sync_secret = var("AI_SYNC_SECRET")?;
        if sync_secret.encode_utf16().count() < 32 {
            return Err("AI_SYNC_SECRET must be at least 32 characters".into());
        }
        let auth = AuthConfig {
            client_id: "ai".into(),
            api_resource: format!("{public_origin}/api/ai"),
            // The crate requires a distinct MCP audience. The registry has no `mcp/ai`
            // entry, so no token is ever minted for it and the gateway mounts no MCP route.
            mcp_resource: format!("{public_origin}/mcp/ai"),
            login_error_path: "/".into(),
            public_origin,
            internal_origin: internal_origin.clone(),
            app_origin: portal_origin.clone(),
            client_secret: var("AI_CLIENT_SECRET")?,
            cookie_secret: var("AI_COOKIE_SECRET")?,
        };
        let backends = match env::var("AI_BACKENDS_FILE") {
            Ok(path) => read_backends(&path)?,
            Err(_) => Vec::new(),
        };
        let cloudflare = match env::var("AI_CLOUDFLARE_FILE") {
            Ok(path) => {
                let raw = fs::read_to_string(&path)
                    .map_err(|e| format!("AI_CLOUDFLARE_FILE {path}: {e}"))?;
                let config: CloudflareConfig = serde_json::from_str(&raw)
                    .map_err(|e| format!("AI_CLOUDFLARE_FILE {path}: {e}"))?;
                if !is_hostname(&config.zone) {
                    return Err("AI_CLOUDFLARE_FILE zone must be a DNS name".into());
                }
                Some(config)
            }
            Err(_) => None,
        };
        Ok(Self {
            listen,
            database_url,
            db_connections: number("AI_DB_CONNECTIONS", 5)?,
            membership_url: format!("{internal_origin}/auth/internal/ai-membership"),
            api_origin,
            portal_origin,
            auth,
            sync_secret,
            web_dir: env::var("WEB_DIR").ok().map(PathBuf::from),
            backends,
            cloudflare,
            max_request_bytes: number("AI_MAX_REQUEST_BYTES", 64 << 20)?,
            log_body_bytes: number("AI_LOG_BODY_BYTES", 1 << 20)?,
            log_retention_days: number("AI_LOG_RETENTION_DAYS", 30)?,
            upstream_idle: std::time::Duration::from_secs(number("AI_UPSTREAM_IDLE_SECS", 90)?),
        })
    }
}

fn read_backends(path: &str) -> Result<Vec<Backend>, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("AI_BACKENDS_FILE {path}: {e}"))?;
    let entries: Vec<BackendEntry> =
        serde_json::from_str(&raw).map_err(|e| format!("AI_BACKENDS_FILE {path}: {e}"))?;
    let mut backends = Vec::new();
    for entry in entries {
        if !valid_name(&entry.name) {
            return Err(format!("backend name {:?} is invalid", entry.name));
        }
        let url = Url::parse(&entry.url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
            .ok_or_else(|| format!("backend {} url must be an HTTP(S) URL", entry.name))?;
        if entry.models.is_empty() {
            return Err(format!("backend {} serves no models", entry.name));
        }
        let credential = match entry.credentials {
            Some(file) => read_credential(&file)?,
            None => Credential::None,
        };
        backends.push(Backend {
            name: entry.name,
            url: url.as_str().trim_end_matches('/').to_owned(),
            models: entry.models,
            credential,
            source: Source::File,
        });
    }
    Ok(backends)
}

fn read_credential(path: &PathBuf) -> Result<Credential, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("credentials {}: {e}", path.display()))?;
    let file: CredentialFile =
        serde_json::from_str(&raw).map_err(|e| format!("credentials {}: {e}", path.display()))?;
    match file {
        CredentialFile {
            bearer: Some(token),
            cf_access_client_id: None,
            cf_access_client_secret: None,
        } => Ok(Credential::Bearer(token)),
        CredentialFile {
            bearer: None,
            cf_access_client_id: Some(id),
            cf_access_client_secret: Some(secret),
        } => Ok(Credential::Access { id, secret }),
        _ => Err(format!(
            "credentials {} must hold either bearer or both Access fields",
            path.display()
        )),
    }
}

/// Backend names: 1-40 characters of letters, digits, `-` and `_`.
pub fn valid_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_hostname(name: &str) -> bool {
    !name.is_empty()
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

pub fn origin(name: &str, raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| format!("{name} must be an HTTP(S) origin"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{name} must be an HTTP(S) origin without credentials, path, query or fragment"
        ));
    }
    Ok(url.origin().ascii_serialization())
}

/// The `Host` header value a request for `origin` carries: host and any explicit port.
pub fn host_of(origin: &str) -> String {
    origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest)
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_and_hosts() {
        assert_eq!(
            origin("X", "https://ai-api.example/").unwrap(),
            "https://ai-api.example"
        );
        assert!(origin("X", "https://ai-api.example/v1").is_err());
        assert_eq!(host_of("https://ai-api.example"), "ai-api.example");
        assert_eq!(
            host_of("http://ai-api.localhost:4010"),
            "ai-api.localhost:4010"
        );
    }

    #[test]
    fn names() {
        assert!(valid_name("gpu-1"));
        assert!(!valid_name(""));
        assert!(!valid_name("a/b"));
        assert!(is_hostname("herkules.dev"));
        assert!(!is_hostname("herkules..dev"));
    }
}
