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

    /*
      A sink we could not build is not a reason to take the application down.

      `send_batch` already says this — "an extension that exits takes the customer's function down
      with it, and losing a log line is not worth an outage of their application" — and applied that
      rule only to sending. Startup was fatal, so a missing variable crashed the function on **every
      invocation**, reported as `Extension.Crash` with the cause in the extension's own log and
      nothing in the customer's.

      That is not hypothetical: the layer attached to every customer function in production is a
      build old enough to want `KAFKA_BROKERS`, and the first application ever to reach an
      invocation was killed by it. An observability component must fail quieter than the thing it
      observes.
    */
    let sink = optional_sink(log_extension::sink::Sink::connect());

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
            && let Some(sink) = sink.as_ref()
            && let Err(cause) = send_batch(sink, &batch).await
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
            if !final_batch.is_empty()
                && let Some(sink) = sink.as_ref()
            {
                let _ = send_batch(sink, &final_batch).await;
            }
            tracing::info!("shutting down");
            return Ok(());
        }
    }
}

/// Configuration failure degrades observability and never the customer function.
fn optional_sink(
    result: anyhow::Result<log_extension::sink::Sink>,
) -> Option<log_extension::sink::Sink> {
    match result {
        Ok(sink) => Some(sink),
        Err(cause) => {
            tracing::error!(%cause, "logs will be dropped; the extension is not configured");
            None
        }
    }
}

/// One HTTP post carrying a whole batch.
///
/// The channel holds individually encoded rows because that is what the Kafka producer wanted, one
/// record per message. The router takes a JSON array, so they are joined here rather than posted
/// one at a time: a request per log line would multiply the customer's invocation latency by the
/// number of lines they wrote.
async fn send_batch(sink: &log_extension::sink::Sink, batch: &[Vec<u8>]) -> anyhow::Result<()> {
    let mut body = Vec::with_capacity(batch.iter().map(|row| row.len() + 1).sum::<usize>() + 2);
    body.push(b'[');
    for (index, row) in batch.iter().enumerate() {
        if index > 0 {
            body.push(b',');
        }
        body.extend_from_slice(row);
    }
    body.push(b']');

    sink.send(&body).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_sink_configuration_does_not_become_an_extension_error() {
        let sink = super::optional_sink(Err(anyhow::anyhow!("SPROUTOS_LOG_ENDPOINT is not set")));
        assert!(sink.is_none());
    }
}
