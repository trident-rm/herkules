//! `herkules-ai`: the AI gateway and portal, one process serving two hosts.

mod api;
mod backends;
mod cloudflare;
mod config;
mod db;
mod keys;
mod levels;
mod membership;
mod portal;
mod usage;

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use herkules_auth::Auth;
use sqlx::PgPool;
use tower::ServiceExt as _;

use crate::{
    backends::{Backend, Backends, Credential, Source, State as BackendState},
    cloudflare::Cloudflare,
    config::Config,
    levels::Levels,
    membership::Membership,
};

pub struct App {
    pub config: Config,
    pub db: PgPool,
    pub auth: Auth,
    /// For backends, the auth service and Cloudflare. No total timeout: generations run long.
    pub http: reqwest::Client,
    pub membership: Membership,
    pub backends: Backends,
    pub levels: Levels,
    pub cloudflare: Option<Cloudflare>,
}

/// Rebuilds the backend set from `AI_BACKENDS_FILE`, the `backends` table and the saved
/// states.
pub async fn reload_backends(app: &App) -> sqlx::Result<()> {
    let states: std::collections::HashMap<String, String> =
        db::backend_states(&app.db).await?.into_iter().collect();
    let state = |name: &str| {
        states
            .get(name)
            .and_then(|s| BackendState::parse(s))
            .unwrap_or(BackendState::Enabled)
    };
    let mut all: Vec<(Backend, BackendState)> = app
        .config
        .backends
        .iter()
        .map(|b| (b.clone(), state(&b.name)))
        .collect();
    let access = app
        .config
        .cloudflare
        .as_ref()
        .map_or(Credential::None, |c| Credential::Access {
            id: c.access_client_id.clone(),
            secret: c.access_client_secret.clone(),
        });
    for row in db::tunnel_backends(&app.db).await? {
        if all.iter().any(|(b, _)| b.name == row.name) {
            tracing::warn!(backend = %row.name, "tunnel backend shadowed by AI_BACKENDS_FILE");
            continue;
        }
        let s = state(&row.name);
        all.push((
            Backend {
                url: format!("https://{}", row.hostname),
                credential: access.clone(),
                source: Source::Tunnel {
                    tunnel_id: row.tunnel_id,
                    dns_record_id: row.dns_record_id,
                    hostname: row.hostname,
                    port: row.port,
                },
                name: row.name,
                models: row.models,
            },
            s,
        ));
    }
    app.backends.replace(all);
    Ok(())
}

/// Checks every backend each [`backends::POLL`], and tunnel status from Cloudflare.
async fn poll(app: Arc<App>) {
    let mut tick = tokio::time::interval(backends::POLL);
    let mut round: u64 = 0;
    loop {
        tick.tick().await;
        let entries = app.backends.all();
        let checks = entries
            .iter()
            .map(|e| backends::check(&app.http, &e.backend));
        let results = futures_util::future::join_all(checks).await;
        // Tunnel status changes slowly; ask Cloudflare every sixth round (30 s).
        let tunnels = round.is_multiple_of(6);
        for (entry, mut live) in entries.iter().zip(results) {
            let previous = entry.live();
            live.tunnel = previous.tunnel.clone();
            if tunnels
                && let (Some(cf), Source::Tunnel { tunnel_id, .. }) =
                    (app.cloudflare.as_ref(), &entry.backend.source)
            {
                live.tunnel = match cf.tunnel(tunnel_id).await {
                    Ok(t) => t.status,
                    Err(e) => {
                        tracing::warn!(backend = %entry.backend.name, "tunnel status: {e}");
                        Some("unknown".into())
                    }
                };
            }
            if previous.healthy != live.healthy {
                tracing::info!(backend = %entry.backend.name, healthy = live.healthy, error = ?live.error, "backend health");
            }
            *entry.live.lock().unwrap() = live;
        }
        round += 1;
    }
}

/// Deletes stored bodies past the retention period, hourly.
async fn purge(app: Arc<App>) {
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        match db::purge_bodies(&app.db, app.config.log_retention_days).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("deleted {n} stored bodies past retention"),
            Err(e) => tracing::error!("body retention: {e}"),
        }
    }
}

/// Sends each request to the API or the portal by its `Host`.
async fn dispatch(
    State((app, api, portal)): State<(Arc<App>, Router, Router)>,
    request: Request,
) -> Response {
    if request.uri().path() == "/healthz" {
        return (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], "ok").into_response();
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let router = if host == config::host_of(&app.config.api_origin) {
        api
    } else if host == config::host_of(&app.config.portal_origin) {
        portal
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match router.oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    if let Err(e) = run().await {
        tracing::error!("{e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Config::from_env()?;
    let db = db::connect(&config.database_url, config.db_connections)
        .await
        .map_err(|e| format!("database: {e}"))?;
    let auth = Auth::new(config.auth.clone()).map_err(|e| format!("OAuth: {e}"))?;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let app = Arc::new(App {
        membership: Membership::new(
            http.clone(),
            config.membership_url.clone(),
            config.sync_secret.clone(),
        ),
        cloudflare: config
            .cloudflare
            .clone()
            .map(|c| Cloudflare::new(http.clone(), c)),
        backends: Backends::default(),
        levels: Levels::default(),
        config,
        db,
        auth,
        http,
    });
    reload_backends(&app)
        .await
        .map_err(|e| format!("backends: {e}"))?;
    app.levels.load(
        db::log_levels(&app.db)
            .await
            .map_err(|e| format!("logging levels: {e}"))?,
    );
    tokio::spawn(poll(Arc::clone(&app)));
    tokio::spawn(purge(Arc::clone(&app)));
    let api = Router::new()
        .fallback(api::handle)
        .with_state(Arc::clone(&app));
    let portal = portal::router(Arc::clone(&app));
    let router = Router::new()
        .fallback(dispatch)
        .with_state((Arc::clone(&app), api, portal));
    let listener = tokio::net::TcpListener::bind(app.config.listen)
        .await
        .map_err(|e| format!("listen {}: {e}", app.config.listen))?;
    tracing::info!(
        listen = %app.config.listen,
        backends = app.backends.all().len(),
        tunnels = app.cloudflare.is_some(),
        "serving"
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|e| format!("server: {e}"))
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = term => {}
    }
}
