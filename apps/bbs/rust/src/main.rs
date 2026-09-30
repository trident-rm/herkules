use std::time::Duration;

use herkules_bbs::{
    config::Config,
    http::{AppState, router},
    library::Library,
    reader::Stylesheet,
};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
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
