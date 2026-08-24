use std::sync::Arc;

use anyhow::Context as _;
use axum::extract::State;
use axum::{Json, Router, routing::post};
use log_extension::runtime::{self, listener_addr};
use log_extension::telemetry::{TelemetryEvent, encode_batch, to_row};
use tokio::sync::mpsc;

/// Where the customer's logs are going, and whose they are.
struct Context {
    project_id: String,
    deployment_id: String,
    tx: mpsc::Sender<Vec<u8>>,
}

/// Telemetry arrives here, one POST per buffered batch.
async fn receive(State(state): State<Arc<Context>>, Json(events): Json<Vec<TelemetryEvent>>) {
    let rows: Vec<_> = events
        .iter()
        .filter_map(|event| to_row(event, &state.project_id, &state.deployment_id))
        .collect();

    for message in encode_batch(&rows) {
        /*
          Dropped rather than awaited when the channel is full.

          This handler runs inside the customer's execution environment on their memory and their
          billed time. Blocking here to preserve a log line would make their function slower and
          could hold the environment open past the invocation — paying, in their money, to keep our
          telemetry. A dropped line is the cheaper failure and Lambda reports its own
          `platform.logsDropped` when it happens upstream for the same reason.
        */
        if state.tx.try_send(message).is_err() {
            tracing::warn!("log buffer full; dropping a line");
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().init();

    let base = runtime::api_base()?;
    let client = reqwest::Client::new();

    // Register first, then subscribe. The other order is refused with a message about an unknown
    // extension identifier, which reads like a bug in the identifier.
    let extension_id = runtime::register(&client, &base).await?;

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(4096);
    let context = Arc::new(Context {
        project_id: std::env::var("SPROUTOS_PROJECT_ID").unwrap_or_default(),
        deployment_id: std::env::var("SPROUTOS_DEPLOYMENT_ID").unwrap_or_default(),
        tx,
    });

    let app = Router::new().route("/", post(receive)).with_state(context);
    let listener = tokio::net::TcpListener::bind(listener_addr())
        .await
        .context("could not bind the telemetry listener")?;
    tokio::spawn(async move {
        if let Err(cause) = axum::serve(listener, app).await {
            tracing::error!(%cause, "the telemetry listener stopped");
        }
    });

    // Only after the listener is accepting: Lambda validates the destination when the subscription
    // is made, and a subscription to a port nothing is listening on is refused.
    runtime::subscribe(&client, &base, &extension_id).await?;
    tracing::info!("subscribed to telemetry");

    let producer = log_extension::kafka::connect().await?;

    loop {
        /*
          Drain before calling `/next`, never after.

          The execution environment is frozen between invocations, and it thaws when `/next`
          returns. A flush left running across that boundary does not continue — it resumes minutes
          later, in an environment whose Kafka connection has been idle the whole time. So
          everything buffered goes out first, and only then does this ask for the next event.
        */
        let mut batch = Vec::new();
        while let Ok(message) = rx.try_recv() {
            batch.push(message);
        }
        if !batch.is_empty()
            && let Err(cause) = producer.send(&batch).await
        {
            // Not fatal. An extension that exits takes the customer's function down with it, and
            // losing a log line is not worth an outage of their application.
            tracing::error!(%cause, count = batch.len(), "could not produce logs");
        }

        let event = runtime::next(&client, &base, &extension_id).await?;
        if event.event_type == "SHUTDOWN" {
            // The last chance. Lambda gives an extension a short grace period here, and anything
            // still buffered when it ends is gone.
            let mut final_batch = Vec::new();
            while let Ok(message) = rx.try_recv() {
                final_batch.push(message);
            }
            if !final_batch.is_empty() {
                let _ = producer.send(&final_batch).await;
            }
            tracing::info!("shutting down");
            return Ok(());
        }
    }
}
