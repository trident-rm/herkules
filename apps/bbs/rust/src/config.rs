use std::{env, net::SocketAddr, path::PathBuf};
use url::Url;

pub struct Config {
    pub database_url: String,
    pub listen: SocketAddr,
    pub app_origin: String,
    pub max_connections: u32,
    pub web_dir: Option<PathBuf>,
    pub auth: Option<crate::session::AuthConfig>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        if env::var("SEARCH_INDEX").is_ok_and(|kind| kind != "trgm") {
            return Err("Rust corpus reads require SEARCH_INDEX=trgm".into());
        }
        let database_url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
        let database =
            Url::parse(&database_url).map_err(|_| "DATABASE_URL must be a Postgres URL")?;
        if !matches!(database.scheme(), "postgres" | "postgresql") {
            return Err("DATABASE_URL must use postgres:// or postgresql://; PGlite is not a network database".into());
        }
        let app_origin = origin(&env::var("APP_ORIGIN").map_err(|_| "APP_ORIGIN is required")?)?;
        let listen = env::var("BBS_RUST_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:3203".into())
            .parse()
            .map_err(|_| "BBS_RUST_LISTEN must be an IP address and port")?;
        let max_connections = env::var("BBS_RUST_DB_CONNECTIONS")
            .unwrap_or_else(|_| "2".into())
            .parse::<u32>()
            .map_err(|_| "BBS_RUST_DB_CONNECTIONS must be an integer from 1 to 10")?;
        if !(1..=10).contains(&max_connections) {
            return Err("BBS_RUST_DB_CONNECTIONS must be from 1 to 10".into());
        }
        let web_dir = env::var("WEB_DIR").ok().map(PathBuf::from);
        let auth = match env::var("PUBLIC_ORIGIN") {
            Ok(raw) => {
                let public_origin = origin(&raw)?;
                let internal_origin = origin(
                    &env::var("AUTH_INTERNAL_URL").unwrap_or_else(|_| public_origin.clone()),
                )?;
                let client_secret = env::var("BBS_CLIENT_SECRET")
                    .map_err(|_| "BBS_CLIENT_SECRET is required in native mode")?;
                let cookie_secret = env::var("BBS_COOKIE_SECRET")
                    .map_err(|_| "BBS_COOKIE_SECRET is required in native mode")?;
                if client_secret.encode_utf16().count() < 32
                    || cookie_secret.encode_utf16().count() < 32
                {
                    return Err(
                        "BBS_CLIENT_SECRET and BBS_COOKIE_SECRET must be at least 32 characters"
                            .into(),
                    );
                }
                Some(crate::session::AuthConfig {
                    public_origin,
                    internal_origin,
                    app_origin: app_origin.clone(),
                    client_secret,
                    cookie_secret,
                })
            }
            Err(_) => {
                if [
                    "AUTH_INTERNAL_URL",
                    "BBS_CLIENT_SECRET",
                    "BBS_COOKIE_SECRET",
                ]
                .iter()
                .any(|k| env::var(k).is_ok())
                {
                    return Err("PUBLIC_ORIGIN is required when configuring native auth".into());
                }
                None
            }
        };
        Ok(Self {
            database_url,
            listen,
            app_origin,
            max_connections,
            web_dir,
            auth,
        })
    }
}

pub fn origin(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| "APP_ORIGIN must be an HTTP(S) origin")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "APP_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment"
                .into(),
        );
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_origins_are_accepted() {
        assert_eq!(
            origin("https://bbs.example/"),
            Ok("https://bbs.example".into())
        );
        for value in [
            "file:///tmp",
            "https://user@bbs.example",
            "https://bbs.example/path",
            "https://bbs.example/?x=1",
            "https://bbs.example/#x",
        ] {
            assert!(origin(value).is_err(), "{value}");
        }
    }
}
