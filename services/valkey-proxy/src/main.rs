//! The `valkey-proxy` binary: configuration, then [`valkey_proxy::serve`] per connection.
//!
//! Everything the proxy actually does lives in the library half, so an integration test can drive
//! a real client through a real backend rather than asserting against a reimplementation of the
//! loop it is supposed to be testing.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::info;
use valkey_proxy::master::MasterQueue;
use valkey_proxy::provision::AclProvisioner;
use valkey_proxy::{CredentialStore, serve};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "valkey_proxy=info".into()),
        )
        .init();

    let listen: SocketAddr = std::env::var("VALKEY_PROXY_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:6379".into())
        .parse()?;
    // A `String`, not a `SocketAddr`. Parsing to `SocketAddr` requires a literal IP, and the value
    // this actually receives in production is an ElastiCache endpoint — a DNS name. The proxy
    // refused to start with "invalid socket address syntax" and crash-looped, while every test
    // passed because the test config is `127.0.0.1:41023`.
    //
    // Resolving per connection rather than once at startup is also the correct behaviour: a
    // `SocketAddr` resolved at boot pins one IP for the process's lifetime, so a failover that
    // moves the endpoint would be invisible until the pod restarted.
    // `Arc` for the same reason as the store: every accepted connection spawns a task that needs it.
    let backend =
        Arc::new(std::env::var("VALKEY_PROXY_BACKEND").unwrap_or_else(|_| "127.0.0.1:6379".into()));

    let database_url = std::env::var("VALKEY_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .map_err(|_| {
            anyhow::anyhow!("VALKEY_PROXY_DATABASE_URL is not set; the proxy cannot authenticate")
        })?;
    let pool_size: usize = std::env::var("VALKEY_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let store = Arc::new(CredentialStore::connect(&database_url, pool_size)?);
    // Checked at boot, not on the first tenant's connection: a bad URL should stop a deploy, not
    // silently turn every authentication into an operational error.
    store.check().await?;

    let acl_root_key = std::env::var("VALKEY_PROXY_ACL_ROOT_KEY").map_err(|_| {
        anyhow::anyhow!("VALKEY_PROXY_ACL_ROOT_KEY is not set; tenant ACL users cannot be derived")
    })?;
    let provisioner = Arc::new(AclProvisioner::new(
        backend.as_ref().clone(),
        acl_root_key.into_bytes(),
    )?);
    provisioner.self_check().await?;
    let identities = store.live_queue_identities().await?;
    let soft_limit = std::env::var("VALKEY_ACL_CARDINALITY_SOFT_LIMIT")
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| {
            anyhow::anyhow!("VALKEY_ACL_CARDINALITY_SOFT_LIMIT must be a positive integer")
        })?
        .unwrap_or(valkey_proxy::reconcile::CARDINALITY_SOFT_LIMIT);
    anyhow::ensure!(
        soft_limit > 0,
        "VALKEY_ACL_CARDINALITY_SOFT_LIMIT must be positive"
    );
    let reconciliation = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        provisioner.reconcile(
            &identities,
            valkey_proxy::reconcile::DEFAULT_REPAIR_LIMIT,
            valkey_proxy::reconcile::DEFAULT_INSPECTION_LIMIT,
            soft_limit,
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Valkey ACL startup reconciliation timed out"))??;
    info!(
        expected = reconciliation.expected,
        observed = reconciliation.observed,
        missing = reconciliation.missing,
        drifted = reconciliation.drifted,
        repaired = reconciliation.repaired,
        orphaned = reconciliation.orphaned,
        pending_repairs = reconciliation.pending_repairs,
        pending_inspections = reconciliation.pending_inspections,
        soft_limit_exceeded = reconciliation.soft_limit_exceeded,
        list_ms = reconciliation.list_latency_ms,
        repair_ms = reconciliation.repair_latency_ms,
        "Valkey ACL startup reconciliation complete"
    );

    /*
      The master queue — TASK 20's second half — is opt-in.

      `VALKEY_PROXY_MASTER_QUEUE=1` turns it on. Off by default because reporting into a shared
      sorted set that nothing consumes is pure write amplification on the tenant instance: a cluster
      with no dispatcher deployed should not pay for one. `MasterQueue::disabled()` accepts and
      discards, so the serve loop is the same code either way.
    */
    let master = if std::env::var("VALKEY_PROXY_MASTER_QUEUE").is_ok_and(|value| value != "0") {
        info!("master queue enabled; enqueues will be reported for dispatch");
        Arc::new(MasterQueue::spawn(backend.as_ref().clone()))
    } else {
        Arc::new(MasterQueue::disabled())
    };

    let listener = TcpListener::bind(listen).await?;
    info!(%listen, backend = %valkey_proxy::upstream::redacted(&backend), "valkey-proxy listening");

    loop {
        let (client, peer) = listener.accept().await?;
        let store = Arc::clone(&store);
        let master = Arc::clone(&master);
        let provisioner = Arc::clone(&provisioner);
        tokio::spawn(async move {
            if let Err(cause) = serve(client, &store, &provisioner, &master).await {
                // Debug rather than warn: a client hanging up mid-command is ordinary, and a log
                // line per disconnect is how a proxy drowns its own useful output.
                tracing::debug!(%peer, %cause, "connection ended");
            }
        });
    }
}
