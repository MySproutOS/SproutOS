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
    // Redacted, because `backend` is a URI whose userinfo is the password. See `redacted`.
    tracing::info!(
        %listen,
        backend = %valkey_proxy::upstream::redacted(&backend),
        "valkey split listening"
    );

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
        upstream_authorization: std::env::var("SEARCH_PROXY_UPSTREAM_AUTHORIZATION").ok(),
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

/// Start the Postgres split, if this deployment has one.
///
/// The fourth listener, and the last one that was still a separate binary. `pg-proxy` was written
/// the same way the other two were — everything in a library, a thin `main` on top — so this is the
/// same move ADR 0026 made for Valkey and search, arriving a release later.
///
/// [ADR 0027] recorded `pg-proxy` as built, tested and deliberately not deployed, on the reasoning
/// that managed Neon wakes its own endpoints and pools its own connections. Two of the three
/// arguments for the proxy did die with that. The third did not, and it is the one that decides
/// whether the product can sell a database at all: **a customer must never hold a Neon credential**,
/// because a customer who holds one can reach their database after we suspend them. `neon-postgres.ts`
/// seals Neon's password under KMS for exactly that reason, and this is the only thing that opens it.
///
/// What changed is not that answer but its price. Deploying the proxy used to mean an Auto Scaling
/// group, a target group and a listener rule for a fourth process; as a listener on the router it is
/// a port and an environment variable.
///
/// Started when there is something to connect onward to — either a shared cluster
/// (`PG_PROXY_BACKEND_PASSWORD`) or the control plane's per-tenant resolver
/// (`PG_PROXY_RESOLVE_URL`). Neither, and this returns `None` exactly as the other two do.
pub async fn postgres(database_url: &str) -> anyhow::Result<Option<JoinHandle<()>>> {
    let resolve = pg_proxy::resolve::resolve_config_from_env();
    let backend_password = std::env::var("PG_PROXY_BACKEND_PASSWORD").ok();

    if resolve.is_none() && backend_password.is_none() {
        return Ok(None);
    }

    let listen = std::env::var("PG_PROXY_LISTEN").unwrap_or_else(|_| "0.0.0.0:5432".into());

    let pool_size: usize = std::env::var("PG_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let store = Arc::new(sproutos_service_credentials::CredentialStore::connect(
        database_url,
        pool_size,
    )?);
    store
        .check()
        .await
        .context("the Postgres split cannot reach the control-plane database")?;

    /*
      The shared cluster, which under Neon is the thing nothing should ever fall through to.

      A tenant whose service the resolver does not know — suspended, deleted, or never Neon in the
      first place — lands here. With no `PG_PROXY_BACKEND_PASSWORD` that is an empty password and a
      refused connection, and refusing is the correct outcome: suspension is only enforceable at the
      point of connection, and a fall-through that succeeded would be the enforcement point quietly
      not existing.
    */
    let backend = pg_proxy::BackendConfig {
        host: std::env::var("PG_PROXY_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("PG_PROXY_BACKEND_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5432),
        user: std::env::var("PG_PROXY_BACKEND_USER").unwrap_or_else(|_| "postgres".into()),
        password: backend_password.unwrap_or_default(),
        // The shared-cluster fallback only. Anything the resolver returns is managed Postgres over
        // the internet and sets this itself.
        require_tls: std::env::var("PG_PROXY_BACKEND_REQUIRE_TLS")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true")),
    };

    // One registry for the process: a `CancelRequest` arrives on a different connection from the
    // session it cancels, so the mapping cannot live in either one.
    let cancels = pg_proxy::cancel::Registry::new();

    // The certificate the Postgres split presents to customers, if this deployment has one. Absent
    // is a working configuration — see `serve_connection`.
    let tls = pg_proxy::backend::client_tls::acceptor()?;
    tracing::info!(tls = tls.is_some(), "postgres split client TLS");

    let resolver = match resolve {
        Some(config) => {
            tracing::info!(url = %config.url, "per-tenant backend resolution enabled");
            Some(pg_proxy::resolve::Resolver::new(
                reqwest::Client::new(),
                config,
            ))
        }
        None => {
            tracing::info!(
                "no resolver configured; routing every connection to the shared cluster"
            );
            None
        }
    };

    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for the Postgres split"))?;
    tracing::info!(%listen, backend = %format!("{}:{}", backend.host, backend.port), "postgres split listening");

    Ok(Some(tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((client, peer)) => {
                    // Nagle off: the wire protocol is request/response and a 40ms delayed ACK on a
                    // small packet is 40ms added to every query a tenant runs.
                    if let Err(cause) = client.set_nodelay(true) {
                        tracing::debug!(%peer, %cause, "could not disable Nagle");
                    }

                    let store = Arc::clone(&store);
                    let backend = backend.clone();
                    let cancels = cancels.clone();
                    let resolver = resolver.clone();
                    let tls = tls.clone();

                    tokio::spawn(async move {
                        if let Err(cause) = pg_proxy::serve_connection(
                            client, store, backend, cancels, resolver, tls,
                        )
                        .await
                        {
                            // Info, not error: a refused password is a normal event on a public
                            // endpoint, and logging it at error level trains people to ignore the
                            // level.
                            tracing::info!(%peer, %cause, "session ended");
                        }
                    });
                }
                Err(cause) => {
                    tracing::error!(%cause, "the Postgres split stopped accepting");
                    return;
                }
            }
        }
    })))
}

/// Start the LLM proxy, if this deployment has one.
///
/// Returns `None` when `LLM_PROXY_LISTEN` is unset. Like the other splits it is optional: a router
/// running to work on request routing needs no model provider anywhere, and a deployment that has
/// not been given a proxy secret should say so rather than bind a port that answers 401 to
/// everything.
///
/// **The secret is checked at boot, not on the first agent turn.** A router with a missing or
/// malformed `LLM_PROXY_SECRET` cannot open any session, so every turn would fail — better to stop
/// the deploy than to serve traffic while one split silently cannot work.
pub async fn llm(database_url: &str) -> anyhow::Result<Option<JoinHandle<()>>> {
    let Ok(listen) = std::env::var("LLM_PROXY_LISTEN") else {
        return Ok(None);
    };

    let key = sproutos_llm_proxy::seal::key_from_env()
        .context("the LLM proxy cannot open sandbox credentials")?;

    let pool_size: usize = std::env::var("LLM_PROXY_DB_POOL")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let store = sproutos_llm_proxy::store::SessionStore::connect(
        database_url,
        pool_size,
        key,
        std::env::var("OPENAI_KEY").ok().filter(|it| !it.is_empty()),
    )?;
    store
        .check()
        .await
        .context("the LLM proxy cannot reach the control-plane database")?;

    /*
      Metering is optional here and loud about it.

      A proxy that forwards model traffic and bills nothing is worse than one that refuses to start,
      *in production* — but in development there is no ingest endpoint and no HMAC key, and
      requiring them would mean nobody can run the router locally. So it starts, and says on every
      turn that the turn is not billed.
    */
    let ingest_url = std::env::var("METERING_INGEST_URL")
        .ok()
        .filter(|it| !it.is_empty());
    let metering_key = std::env::var("METERING_INGEST_HMAC_KEY")
        .ok()
        .filter(|it| !it.is_empty())
        .map(|it| it.into_bytes());
    if ingest_url.is_none() || metering_key.is_none() {
        tracing::warn!("the LLM proxy is running without metering; model usage will not be billed");
    }

    let state = Arc::new(sproutos_llm_proxy::serve::ProxyState {
        store,
        /*
          No timeout on this client, deliberately.

          An agent turn legitimately streams for minutes, and reqwest's default would cut it. The
          bound that matters is the upstream's own, and a customer whose model call is genuinely
          stuck is better served by their own client giving up than by us truncating a response
          mid-token.
        */
        http: reqwest::Client::builder().build()?,
        ingest_url,
        metering_key,
    });

    let app = AxumRouter::new()
        .fallback(any(sproutos_llm_proxy::serve::handle))
        .with_state(state);

    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("the LLM proxy could not bind {listen}"))?;
    tracing::info!(%listen, "LLM proxy listening");

    Ok(Some(tokio::spawn(async move {
        if let Err(cause) = axum::serve(listener, app).await {
            tracing::error!(%cause, "the LLM proxy stopped serving");
        }
    })))
}
