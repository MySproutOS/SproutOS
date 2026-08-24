//! The tenant splits, running inside the router.
//!
//! §3.2 and §4.3–4.4: `valkey-proxy` and `search-proxy` become listeners on this process rather
//! than separate deployments. Their logic is unchanged — both crates were written as a library with
//! a thin binary on top, so this reuses the tested code rather than reimplementing it.
//!
//! **Why merge them at all.** Under Kubernetes each proxy was a Deployment with its own Service and
//! its own scaling; on EC2 behind one ALB they would be three Auto Scaling groups, three target
//! groups and three sets of health checks for three processes that all do the same thing:
//! identify a tenant, rewrite, forward. One process is one thing to deploy, one to scale, and one place a
//! tenant's identity is established.
//!
//! Each listener is optional. A developer running the router to work on request routing should not
//! need a Valkey and an OpenSearch to start it, and a deployment that has not been given an
//! upstream should say so rather than bind a port that answers nothing.

use std::sync::Arc;

use anyhow::Context as _;
use axum::Router as AxumRouter;
use axum::routing::any;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Start the Valkey split, if this deployment has one.
///
/// Returns `None` when `VALKEY_PROXY_BACKEND` is unset — not an error. The router's own job is
/// resolving hostnames to functions, and that works with no tenant Valkey anywhere.
pub async fn valkey(database_url: &str) -> anyhow::Result<Option<JoinHandle<()>>> {
    let Ok(backend) = std::env::var("VALKEY_PROXY_BACKEND") else {
        return Ok(None);
    };

    let listen = std::env::var("VALKEY_PROXY_LISTEN").unwrap_or_else(|_| "0.0.0.0:6379".into());

    /*
      A `String` upstream, not a `SocketAddr`.

      Parsing to `SocketAddr` needs a literal IP, and what this receives in production is a DNS
      name. Resolving per connection is also correct rather than merely convenient: an address
      resolved once at boot pins one IP for the process's lifetime, so a failover that moved the
      endpoint would be invisible until a restart.
    */
    let backend = Arc::new(backend);

    let pool_size: usize = std::env::var("VALKEY_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let store = Arc::new(valkey_proxy::CredentialStore::connect(
        database_url,
        pool_size,
    )?);
    // Checked at boot, not on the first tenant's connection: a bad URL should stop a deploy rather
    // than turn every authentication into an operational error.
    store
        .check()
        .await
        .context("the Valkey split cannot reach the control-plane database")?;

    let master = if std::env::var("VALKEY_PROXY_MASTER_QUEUE").is_ok_and(|value| value != "0") {
        tracing::info!("master queue enabled; enqueues will be reported for dispatch");
        Arc::new(valkey_proxy::master::MasterQueue::spawn(
            backend.as_ref().clone(),
        ))
    } else {
        Arc::new(valkey_proxy::master::MasterQueue::disabled())
    };

    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for the Valkey split"))?;
    tracing::info!(%listen, backend = %backend, "valkey split listening");

    Ok(Some(tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((client, peer)) => {
                    let store = Arc::clone(&store);
                    let backend = Arc::clone(&backend);
                    let master = Arc::clone(&master);
                    tokio::spawn(async move {
                        if let Err(cause) =
                            valkey_proxy::serve(client, &backend, &store, &master).await
                        {
                            // Debug rather than warn: a client hanging up mid-command is ordinary,
                            // and a line per disconnect is how a proxy drowns its own output.
                            tracing::debug!(%peer, %cause, "connection ended");
                        }
                    });
                }
                Err(cause) => {
                    tracing::error!(%cause, "the Valkey split stopped accepting");
                    return;
                }
            }
        }
    })))
}

/// Start the OpenSearch split, if this deployment has one.
pub async fn search(database_url: &str) -> anyhow::Result<Option<JoinHandle<()>>> {
    let Ok(upstream) = std::env::var("SEARCH_PROXY_UPSTREAM") else {
        return Ok(None);
    };

    let listen = std::env::var("SEARCH_PROXY_LISTEN").unwrap_or_else(|_| "0.0.0.0:9200".into());

    let pool_size: usize = std::env::var("SEARCH_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8);

    let store = Arc::new(sproutos_service_credentials::CredentialStore::connect(
        database_url,
        pool_size,
    )?);
    store
        .check()
        .await
        .context("the search split cannot reach the control-plane database")?;

    let proxy = Arc::new(search_proxy::Proxy {
        store,
        upstream: upstream.clone(),
        client: reqwest::Client::builder()
            // The tenant's own timeout is what should govern a slow query; this only bounds a
            // cluster that has stopped answering at all.
            .timeout(std::time::Duration::from_secs(120))
            .build()?,
    });

    let app = AxumRouter::new()
        .fallback(any(search_proxy::handle))
        .with_state(proxy);

    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for the search split"))?;
    tracing::info!(%listen, %upstream, "search split listening");

    Ok(Some(tokio::spawn(async move {
        if let Err(cause) = axum::serve(listener, app).await {
            tracing::error!(%cause, "the search split stopped serving");
        }
    })))
}
