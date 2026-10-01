//! Rust corpus worker; migrations remain owned by the existing Drizzle history.
pub mod content;
pub mod corpus;
pub mod guard;
mod render;
pub mod source;
pub mod title;
pub mod worker;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub enum Error {
    Database(sqlx::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    Url(url::ParseError),
    Source {
        kind: &'static str,
        message: String,
        retry: Option<i64>,
    },
    Throttled {
        until: i64,
        reason: &'static str,
    },
    LockHeld,
    Internal(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(e) => write!(f, "{e}"),
            Self::Json(e) => write!(f, "{e}"),
            Self::Http(e) => write!(f, "network error: {e}"),
            Self::Url(e) => write!(f, "{e}"),
            Self::Source {
                kind,
                message,
                retry,
            } => match *kind {
                "forbidden" => write!(f, "forbidden (http 403)"),
                "notFound" => write!(f, "not found"),
                "rateLimited" | "serverError" | "http" => {
                    write!(f, "{message}")?;
                    if let Some(retry) = retry {
                        write!(f, " (retry-after {retry}s)")?;
                    }
                    Ok(())
                }
                "invalid" => write!(f, "invalid response: {message}"),
                "blocked" => write!(f, "blocked: {message}"),
                _ => write!(f, "{message}"),
            },
            Self::Throttled { until, reason } => write!(f, "throttled until {until} ({reason})"),
            Self::LockHeld => write!(f, "another bbs worker holds the lock"),
            Self::Internal(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}
impl From<url::ParseError> for Error {
    fn from(e: url::ParseError) -> Self {
        Self::Url(e)
    }
}
/// CLI intentionally needs only DATABASE_URL: no OAuth secrets, web assets or HTTP listener.
pub async fn cli(args: &[String]) -> u8 {
    let once = match args {
        [] => false,
        [flag] if flag == "--once" => true,
        _ => {
            eprintln!("usage: herkules-bbs work [--once]");
            return 2;
        }
    };
    match run(once).await {
        Ok(()) => 0,
        Err(Error::LockHeld) => {
            eprintln!("bbs work: another bbs worker holds the lock");
            3
        }
        Err(e) => {
            eprintln!("bbs work: {e}");
            1
        }
    }
}
async fn run(once: bool) -> Result<()> {
    let url = std::env::var("DATABASE_URL").map_err(|_| {
        Error::Internal(
            "DATABASE_URL is required; Rust work needs a migrated Postgres database".into(),
        )
    })?;
    if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
        return Err(Error::Internal(
            "Rust work requires Postgres; PGlite is not supported".into(),
        ));
    }
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .after_connect(|c, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = '5s'")
                    .execute(c)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    // Refuse version drift before any write or source request; Node preparation owns rederivation.
    let versions: Option<(String, String, String)> = sqlx::query_as(
        "SELECT render_version,normalize_version,title_version FROM corpus_versions WHERE id=1",
    )
    .fetch_optional(&pool)
    .await
    .map_err(|_| Error::Internal("database is not migrated: run bbs migrate first".into()))?;
    if versions
        .as_ref()
        .map(|v| (v.0.as_str(), v.1.as_str(), v.2.as_str()))
        != Some((
            content::RENDER_VERSION,
            content::NORMALIZE_VERSION,
            title::TITLE_VERSION,
        ))
    {
        return Err(Error::Internal("corpus derivation versions do not match this worker: run the matching bbs migrate preparation job".into()));
    }
    let mut lock = corpus::lock(&url).await?;
    let corpus = corpus::Corpus { pool: pool.clone() };
    corpus.boot().await?;
    let guard = guard::Guard::load(pool.clone(), guard::Policy::default()).await?;
    let worker = worker::Worker {
        corpus,
        source: source::Source::new(guard.clone())?,
        guard,
    };
    let (stop, receiver) = tokio::sync::watch::channel(false);
    let result = {
        let operation = async {
            if once {
                let o = worker.cycle("manual", worker::ONCE).await?;
                println!("{}", serde_json::to_string(&o)?);
                if o.error.is_some() {
                    return Err(Error::Internal("manual crawl failed".into()));
                }
                Ok(())
            } else {
                worker.work(receiver).await
            }
        };
        // A lost lock connection ends the worker. It must never continue after Postgres releases its lock.
        let monitor = async {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    sqlx::query("SELECT 1").execute(&mut lock),
                )
                .await
                .map_err(|_| Error::Internal("worker lock connection is unresponsive".into()))??;
            }
            #[allow(unreachable_code)]
            Ok::<(), Error>(())
        };
        tokio::pin!(operation, monitor);
        tokio::select! {
            r=&mut operation=>r,
            r=&mut monitor=>{stop.send_replace(true);r},
            _=crate::crawl::shutdown()=>{
                stop.send_replace(true);
                if once {Ok(())} else {
                    // Keep checking lock ownership while the daemon finishes its current unit.
                    tokio::select! {r=&mut operation=>r,r=&mut monitor=>r}
                }
            },
        }
    };
    // Dropping the dedicated connection releases the lock even on failure.
    drop(lock);
    pool.close().await;
    result
}
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {_=interrupt=>{},_=terminate=>{}}
}
