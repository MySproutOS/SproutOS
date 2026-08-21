//! The `pg-proxy` binary: configuration, then [`pg_proxy::serve_connection`] per connection.
//!
//! Everything the proxy does lives in the library half, so an integration test can drive a real
//! `tokio-postgres` client through a real Postgres rather than asserting against a reimplementation
//! of the loop it is supposed to be testing.

use std::net::SocketAddr;
use std::sync::Arc;

use pg_proxy::{BackendConfig, Waker, cancel, serve_connection, wake};
use sproutos_service_credentials::CredentialStore;
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pg_proxy=info".into()),
        )
        .init();

    let listen: SocketAddr = std::env::var("PG_PROXY_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:5432".into())
        .parse()?;

    let database_url = std::env::var("PG_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| {
            anyhow::anyhow!("PG_PROXY_DATABASE_URL is not set; the proxy cannot authenticate")
        })?;
    let pool_size: usize = std::env::var("PG_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let store = Arc::new(CredentialStore::connect(&database_url, pool_size)?);
    // Fail at boot rather than on the first tenant's connection. A proxy that starts without being
    // able to reach the credential store is a proxy that reports healthy and refuses everybody.
    store.check().await?;

    let backend = BackendConfig {
        host: std::env::var("PG_PROXY_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("PG_PROXY_BACKEND_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5432),
        user: std::env::var("PG_PROXY_BACKEND_USER").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("PG_PROXY_BACKEND_PASSWORD").map_err(|_| {
            anyhow::anyhow!("PG_PROXY_BACKEND_PASSWORD is not set; the proxy cannot connect")
        })?,
    };

    // One registry for the process: a `CancelRequest` arrives on a different connection from the
    // session it cancels, so the mapping cannot live in either one.
    let cancels = cancel::Registry::new();

    /*
        Wake-on-connect, when this deployment has Neon behind it.

        `None` is the ordinary case today and the proxy behaves exactly as before: a `sprout`
        database is a database and a role on a cluster that is always up, with nothing to wake.
        Logged either way, because "why did my connection not start a compute" has a one-line
        answer and it should be in the log rather than in someone's head.
    */
    let waker = match wake::wake_config_from_env() {
        Some(config) => {
            info!(url = %config.url, "wake-on-connect enabled");
            Some(Waker {
                client: reqwest::Client::new(),
                config,
            })
        }
        None => {
            info!("wake-on-connect not configured; routing every connection to the shared cluster");
            None
        }
    };

    let listener = TcpListener::bind(listen).await?;
    info!(%listen, backend = %format!("{}:{}", backend.host, backend.port), "pg-proxy listening");

    loop {
        let (client, peer) = listener.accept().await?;
        // Nagle off: the wire protocol is request/response and a 40ms delayed ACK on a small packet
        // is 40ms added to every query a tenant runs.
        client.set_nodelay(true)?;

        let store = Arc::clone(&store);
        let backend = backend.clone();
        let cancels = cancels.clone();
        // Cloned per connection, like the others: the task outlives this iteration.
        let waker = waker.clone();

        tokio::spawn(async move {
            if let Err(cause) = serve_connection(client, store, backend, cancels, waker).await {
                // Info, not error: a refused password is a normal event on a public endpoint, and
                // logging it at error level trains people to ignore the level.
                info!(%peer, %cause, "session ended");
            }
        });
    }
}
