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

    let state = Arc::new(Router {
        resolver: Resolver::new(manager),
        lambda,
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
        .with_state(state);

    let port = std::env::var("ROUTER_PORT").unwrap_or_else(|_| "8080".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .with_context(|| format!("could not bind port {port}"))?;

    tracing::info!(port, "router listening");
    axum::serve(listener, app).await.context("serving failed")?;
    Ok(())
}
