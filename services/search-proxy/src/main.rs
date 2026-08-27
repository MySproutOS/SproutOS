//! The `search-proxy` binary: configuration, then [`search_proxy::handle`] per request.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::routing::any;
use search_proxy::security::SecurityManager;
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

    let client = reqwest::Client::builder()
        // The tenant's own timeout is what should govern a slow query; this only bounds a
        // cluster that has stopped answering at all.
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let security_root_key = std::env::var("SEARCH_PROXY_SECURITY_ROOT_KEY").map_err(|_| {
        anyhow::anyhow!(
            "SEARCH_PROXY_SECURITY_ROOT_KEY is not set; server-enforced tenant isolation is required"
        )
    })?;
    let security = SecurityManager::new(client.clone(), upstream.clone(), security_root_key)?;

    let metering = search_meter(&client, &security, &upstream);

    let proxy = Arc::new(Proxy {
        store,
        upstream: upstream.clone(),
        client,
        security,
        metering,
    });

    let app = Router::new().fallback(any(handle)).with_state(proxy);

    let listener = tokio::net::TcpListener::bind(listen).await?;
    info!(%listen, %upstream, "search-proxy listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn search_meter(
    client: &reqwest::Client,
    security: &SecurityManager,
    upstream: &str,
) -> Option<search_proxy::metering::SearchMeter> {
    let ingest_url = std::env::var("METERING_INGEST_URL")
        .ok()
        .filter(|value| !value.is_empty());
    let key = std::env::var("METERING_INGEST_HMAC_KEY")
        .ok()
        .filter(|value| !value.is_empty());
    let (Some(ingest_url), Some(key)) = (ingest_url, key) else {
        tracing::warn!("search metering is not configured; search usage will not be billed");
        return None;
    };
    let directory = std::env::var("SEARCH_METERING_SPOOL_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("search-metering"));
    let spool = match sproutos_llm_proxy::spool::MeteringSpool::open(
        directory,
        sproutos_llm_proxy::spool::SpoolLimits::default(),
    ) {
        Ok(spool) => spool,
        Err(cause) => {
            tracing::error!(%cause, "search metering is disabled; durable spool could not open");
            return None;
        }
    };
    spool.spawn_delivery(sproutos_llm_proxy::spool::DeliveryConfig::new(
        client.clone(),
        ingest_url,
        key.into_bytes(),
    ));
    let meter = search_proxy::metering::SearchMeter::new(spool);
    meter.spawn_storage_sampling(security.clone(), client.clone(), upstream.to_owned());
    Some(meter)
}
