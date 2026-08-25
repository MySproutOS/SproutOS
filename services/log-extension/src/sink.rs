//! Shipping a batch of records to the router, which owns the Kafka connection.
//!
//! ## What this replaced, and why
//!
//! This module used to be a Kafka producer. The extension held a SASL credential, opened a TLS
//! connection to a broker in another datacentre, and produced directly. Three things were wrong
//! with that, and only the first is a security problem:
//!
//! 1. **The credential was in the customer's environment.** `process.env` is not a boundary against
//!    the process it belongs to, so the customer's own code could read it — and it was authorized
//!    to write the shared `runtime-logs` topic. Kafka cannot validate a message body, so anyone
//!    holding it could publish records carrying another tenant's `project_id`. Those records carry
//!    `billed_ms`. Forged logs were forged bills.
//! 2. **A handshake per cold start.** TLS then SCRAM, several round trips, inside the customer's
//!    billed duration, to deliver telemetry they did not ask for.
//! 3. **A broker connection per concurrent sandbox.** Lambda's concurrency became Kafka's
//!    connection count — a number neither we nor the customer control.
//!
//! Now the extension posts to the router over HTTP with a token that says only *which project this
//! is*. The router verifies it, stamps the project itself, and streams to Kafka over a connection
//! it holds open. The customer can still read the token; it is worth nothing beyond writing logs to
//! their own project, which `console.log` already does.

use anyhow::Context as _;
use serde::Serialize;

pub struct Sink {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    deployment_id: String,
}

/// The batch as the router's ingest expects it.
///
/// No `project_id` field exists, deliberately: the router does not read one and there is nothing
/// here to send. The type is the boundary.
#[derive(Debug, Serialize)]
pub struct OutgoingBatch<'a> {
    #[serde(flatten)]
    pub records: &'a serde_json::Value,
}

impl Sink {
    pub fn connect() -> anyhow::Result<Self> {
        let endpoint = std::env::var("SPROUTOS_LOG_ENDPOINT")
            .context("SPROUTOS_LOG_ENDPOINT is not set; the extension has nowhere to send logs")?;
        let token = std::env::var("SPROUTOS_LOG_TOKEN")
            .context("SPROUTOS_LOG_TOKEN is not set; the router would refuse every batch")?;

        /*
          A short timeout, because this runs on the customer's clock.

          The extension is holding an invocation open while this call is outstanding. The router
          answers without waiting for Kafka — it queues and returns — so a slow response means the
          router itself is in trouble, and waiting longer will not produce a better outcome than
          giving up and letting the next invocation try.
        */
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            // Kept alive across invocations. The environment is frozen between them, not torn down,
            // so the TCP connection survives and most batches cost no handshake at all.
            .pool_idle_timeout(std::time::Duration::from_secs(300))
            .build()
            .context("could not build the log client")?;

        Ok(Self {
            client,
            endpoint,
            token,
            deployment_id: std::env::var("SPROUTOS_DEPLOYMENT_ID").unwrap_or_default(),
        })
    }

    /// Post one batch. Errors are the caller's to log and swallow — see `main.rs`.
    pub async fn send(&self, body: &[u8]) -> anyhow::Result<()> {
        let response = self
            .client
            .post(&self.endpoint)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header("x-sproutos-deployment", &self.deployment_id)
            .body(body.to_vec())
            .send()
            .await
            .context("could not reach the log endpoint")?;

        if !response.status().is_success() {
            let status = response.status();
            anyhow::bail!("log endpoint refused the batch: {status}");
        }

        Ok(())
    }
}
