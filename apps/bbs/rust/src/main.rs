use std::time::Duration;

use herkules_bbs::{
    config::Config,
    http::{AppState, router},
    library::Library,
    reader::Stylesheet,
};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn logging_subscriber<W>(
    filter: tracing_subscriber::EnvFilter,
    writer: W,
) -> impl tracing::Subscriber + Send + Sync
where
    W: for<'a> tracing_subscriber::fmt::MakeWriter<'a> + Send + Sync + 'static,
{
    tracing_subscriber::registry()
        // This global filter rejects SDK events and spans before formatting.
        // EnvFilter specificity or span directives cannot override this boundary.
        .with(tracing_subscriber::filter::filter_fn(|metadata| {
            !metadata.target().starts_with("larksuite_oapi_sdk_rs")
        }))
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(writer))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    logging_subscriber(
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        std::io::stdout,
    )
    .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "work") {
        let code = herkules_bbs::crawl::cli(&args[1..]).await;
        std::process::exit(i32::from(code));
    }
    if args.first().is_some_and(|a| a == "bot") {
        match herkules_bbs::bot::cli::run(&args[1..]).await {
            Ok(code) => std::process::exit(i32::from(code)),
            Err(error) => {
                tracing::error!(%error, "bot failed");
                std::process::exit(1);
            }
        }
    }
    if !args.is_empty() {
        return Err(std::io::Error::other("usage: herkules-bbs [work [--once] | bot]").into());
    }
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let pool = PgPoolOptions::new()
        .min_connections(0)
        .max_connections(config.max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .after_connect(|connection, _| {
            Box::pin(async move {
                // This increment only reads the corpus. Schema and write ownership remain in Node.
                sqlx::query("SET default_transaction_read_only = on")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET statement_timeout = '5s'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&config.database_url)
        .await
        .map_err(|error| {
            std::io::Error::other(format!(
                "Could not connect to the BBS Postgres database: {error}. \
                 DATABASE_URL must point to a running Postgres server with valid credentials. \
                 The default local BBS setup uses PGlite, which this Rust service cannot open. \
                 See apps/bbs/rust/README.md for local Postgres setup."
            ))
        })?;
    // Fail before listening when the corpus has not been migrated by the existing service.
    sqlx::query("SELECT id, content_html FROM articles LIMIT 0")
        .execute(&pool)
        .await?;
    let stylesheet = config
        .web_dir
        .as_deref()
        .map(Stylesheet::load)
        .transpose()?;
    if stylesheet.is_none() {
        tracing::info!(
            "WEB_DIR unset: reader preview uses semantic HTML without the Vite stylesheet"
        );
    }
    let auth = config
        .auth
        .map(herkules_bbs::session::Auth::new)
        .transpose()?
        .map(std::sync::Arc::new);
    // Keep corpus reads read-only. Native REST has one narrowly scoped write:
    // the existing idempotent stale-article refresh request.
    let refresh_pool = if auth.is_some() {
        Some(
            PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(5))
                .after_connect(|c, _| {
                    Box::pin(async move {
                        sqlx::query("SET statement_timeout = '5s'")
                            .execute(c)
                            .await?;
                        Ok(())
                    })
                })
                .connect(&config.database_url)
                .await?,
        )
    } else {
        None
    };
    let mut app = router(AppState {
        library: Library::new(pool.clone()),
        app_origin: config.app_origin.clone(),
        stylesheet: stylesheet.map(|s| s.url),
        auth,
        refresh_pool: refresh_pool.clone(),
    });
    if let Some(web_dir) = config.web_dir {
        app = app.fallback_service(herkules_bbs::web::router(
            &web_dir,
            Library::new(pool.clone()),
            config.app_origin.clone(),
        )?);
    }
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(address = %listener.local_addr()?, "bbs-rust listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    pool.close().await;
    if let Some(pool) = refresh_pool {
        pool.close().await;
    }
    Ok(())
}

async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = interrupt => {}, _ = terminate => {} }
}

#[cfg(test)]
mod logging_tests {
    use super::logging_subscriber;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn sdk_logs_cannot_be_enabled_by_specific_environment_directives() {
        let output = Capture::default();
        let filter = "warn,larksuite_oapi_sdk_rs::transport=trace,larksuite_oapi_sdk_rs::ws[connection]=trace"
            .parse().unwrap();
        let subscriber = logging_subscriber(filter, output.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "larksuite_oapi_sdk_rs::transport", "SDK_REQUEST_SECRET");
            tracing::error!(target: "larksuite_oapi_sdk_rs", "SDK_ROOT_SECRET");
            let span = tracing::trace_span!(target: "larksuite_oapi_sdk_rs::ws", "connection", token="SDK_SPAN_SECRET");
            let _entered = span.enter();
            tracing::warn!(target: "larksuite_oapi_sdk_rs::ws", "SDK_EVENT_SECRET");
            tracing::warn!(target: "herkules_bbs", "APPLICATION_WARNING");
            tracing::info!(target: "herkules_bbs", "APPLICATION_INFO_FILTERED");
        });
        let bytes = output.0.lock().unwrap();
        let log = String::from_utf8_lossy(&bytes);
        assert!(log.contains("APPLICATION_WARNING"));
        assert!(!log.contains("APPLICATION_INFO_FILTERED"));
        assert!(!log.contains("SDK_"));
        assert!(!log.contains("larksuite_oapi_sdk_rs"));
    }
}
