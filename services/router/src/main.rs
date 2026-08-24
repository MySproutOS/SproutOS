use std::sync::Arc;

use anyhow::Context as _;
use aws_sdk_lambda::Client as LambdaClient;
use axum::Router as AxumRouter;
use axum::routing::any;
use redis::aio::ConnectionManager;
use router::resolve::Resolver;
use router::serve::{self, Router};

/// The front door for every customer application.
///
/// One process, one port, behind the ALB's host-based rules. `sproutos.me` goes to the website
/// target group; every tenant host comes here.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().init();

    let valkey_url = std::env::var("VALKEY_URL").context("VALKEY_URL is not set")?;
    let client = redis::Client::open(valkey_url).context("VALKEY_URL is not a Valkey URL")?;
    let manager = ConnectionManager::new(client)
        .await
        .context("could not reach the platform Valkey")?;

    // The SDK's own resolution chain, so `AWS_ENDPOINT_URL` points this at LocalStack in
    // development and nothing in the code has to know which it is talking to.
    let config = aws_config::load_from_env().await;
    let lambda = LambdaClient::new(&config);

    let dispatch_manager = manager.clone();
    let state = Arc::new(Router {
        resolver: Resolver::new(manager),
        lambda,
        /*
          The ceiling on any single wait.

          Lambda's own maximum is 15 minutes, and a customer configured for that is entitled to it —
          this is the router refusing to hold a connection longer than the function could possibly
          run, not a policy about how long a request may take.
        */
        function_timeout: std::time::Duration::from_secs(
            std::env::var("ROUTER_MAX_INVOCATION_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(900),
        ),
    });

    /*
      A catch-all, because the path belongs to the customer's application and not to us.

      `/healthz` is the one exception, and it is registered against **our** host rather than as a
      path: reserving the path outright would take `/healthz` away from every customer application,
      and a customer whose framework serves a health endpoint would find ours instead of theirs.
      The load balancer's probe sends no meaningful `Host`, so `serve::handle` answers it before
      resolution — see `HEALTH_PATH` there.
    */
    let app = AxumRouter::new()
        .fallback(any(serve::handle))
        .with_state(Arc::clone(&state));

    let port = std::env::var("ROUTER_PORT").unwrap_or_else(|_| "8080".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .with_context(|| format!("could not bind port {port}"))?;

    /*
      The tenant splits, in this process.

      Both are optional and both are started before the HTTP server, so a misconfigured upstream
      fails the boot rather than leaving the router serving requests while one split silently is
      not there. A deployment with no tenant Valkey and no OpenSearch — a developer working on
      request routing — starts with neither and says so in the log.
    */
    let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
    let splits = if database_url.is_empty() {
        tracing::info!("DATABASE_URL is not set; the tenant splits are off");
        Vec::new()
    } else {
        [
            router::listeners::valkey(&database_url).await?,
            router::listeners::search(&database_url).await?,
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
    };
    tracing::info!(splits = splits.len(), "tenant splits running");

    /*
      Workflow dispatch (§4.6).

      Started only where the master queue is on: `valkey-proxy` reports into it when
      `VALKEY_PROXY_MASTER_QUEUE` is set, and a dispatcher polling a set nothing writes to is a
      Valkey round trip every two seconds, forever, to learn nothing.
    */
    if std::env::var("VALKEY_PROXY_MASTER_QUEUE").is_ok_and(|value| value != "0") {
        let dispatch_valkey = dispatch_manager.clone();
        let dispatch_lambda = state.lambda.clone();
        tokio::spawn(async move {
            router::dispatch::run(dispatch_valkey, dispatch_lambda).await;
        });
        tracing::info!("workflow dispatch running");
    }

    tracing::info!(port, "router listening");
    axum::serve(listener, app).await.context("serving failed")?;
    Ok(())
}
