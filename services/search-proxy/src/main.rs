//! The `search-proxy` binary: configuration, then [`search_proxy::handle`] per request.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::routing::any;
use search_proxy::{Proxy, handle};
use sproutos_service_credentials::CredentialStore;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "search_proxy=info".into()),
        )
        .init();

    let listen: SocketAddr = std::env::var("SEARCH_PROXY_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:9200".into())
        .parse()?;
    let upstream =
        std::env::var("SEARCH_PROXY_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:9200".into());

    let database_url = std::env::var("SEARCH_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| {
            anyhow::anyhow!("SEARCH_PROXY_DATABASE_URL is not set; the proxy cannot authenticate")
        })?;
    let pool_size: usize = std::env::var("SEARCH_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8);

    let store = Arc::new(CredentialStore::connect(&database_url, pool_size)?);
    // Checked at boot: a bad URL should stop a deploy rather than turn every tenant's first search
    // into an operational error.
    store.check().await?;

    let proxy = Arc::new(Proxy {
        store,
        upstream: upstream.clone(),
        client: reqwest::Client::builder()
            // The tenant's own timeout is what should govern a slow query; this only bounds a
            // cluster that has stopped answering at all.
            .timeout(std::time::Duration::from_secs(120))
            .build()?,
    });

    let app = Router::new().fallback(any(handle)).with_state(proxy);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!(%listen, %upstream, "search-proxy listening");
    axum::serve(listener, app).await?;
    Ok(())
}
