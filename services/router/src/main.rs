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

    /*
      Which TLS implementation, decided here rather than by whichever crate is compiled first.

      rustls 0.23 takes its cipher suites from a process-wide `CryptoProvider`, and it will only
      infer one when exactly one is compiled in. Two are: the AWS SDK brings `aws-lc-rs` and redis
      brings `ring`. With both present rustls does not choose — it **panics on the first TLS
      connection**, which is the router's first read from the platform Valkey, before it has served
      anything. `SIGABRT`, restart, `SIGABRT`, and an Auto Scaling group replacing the instance
      every three minutes.

      `aws-lc-rs` because the AWS SDK is the heavier user of TLS here and it is that crate's own
      default; the choice matters far less than making one.

      The result is ignored deliberately: `install_default` fails only if a provider is already
      installed, and this is the first thing `main` does.
    */
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let valkey_url = std::env::var("VALKEY_URL").context("VALKEY_URL is not set")?;
    let client = redis::Client::open(valkey_url).context("VALKEY_URL is not a Valkey URL")?;
    let manager = ConnectionManager::new(client)
        .await
        .context("could not reach the platform Valkey")?;

    // The SDK's own resolution chain, so `AWS_ENDPOINT_URL` points this at LocalStack in
    // development and nothing in the code has to know which it is talking to.
    let config = aws_config::load_from_env().await;
    let lambda = LambdaClient::new(&config);

    /*
      The log pipeline, started before anything serves.

      One producer for the whole instance rather than one per sandbox. It is optional: without
      `KAFKA_BROKERS` the router serves traffic exactly as before and accepts log posts into a void,
      which is what a developer running this on a laptop wants.

      A failure to reach Kafka at start is logged and not fatal. The router's job is to serve
      customers' applications; refusing to boot because a log broker is down would turn an
      observability outage into a platform one.
    */
    let log_token_secret = std::env::var("LOG_TOKEN_SECRET").unwrap_or_default();
    let logs = if std::env::var("KAFKA_BROKERS").is_ok_and(|value| !value.is_empty()) {
        match log_extension_producer().await {
            Ok(sink) => Some(sink),
            Err(cause) => {
                tracing::error!(%cause, "runtime logs are not being collected");
                None
            }
        }
    } else {
        None
    };

    let dispatch_manager = manager.clone();
    let state = Arc::new(Router {
        resolver: Resolver::new(manager),
        lambda,
        logs,
        log_token_secret: log_token_secret.into_bytes(),
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

/// Connect to Kafka and start the task that drains the channel into it.
///
/// Returns the sending half. The task owns the producer and lives as long as the process, which is
/// the entire point of moving this out of the Lambda extension: one handshake per instance instead
/// of one per cold start, and a broker that sees a handful of connections rather than one per
/// concurrent sandbox.
async fn log_extension_producer() -> anyhow::Result<router::logs::LogSink> {
    let producer = router::log_kafka::KafkaProducer::connect().await?;
    let (tx, rx) = tokio::sync::mpsc::channel(router::logs::QUEUE_DEPTH);

    tokio::spawn(router::logs::Producer::new(std::sync::Arc::new(producer)).run(rx));

    Ok(router::logs::LogSink::new(tx))
}
