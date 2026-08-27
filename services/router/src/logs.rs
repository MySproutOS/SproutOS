//! Taking customers' runtime logs and streaming them to Kafka over one connection we own.
//!
//! ## Why this is here rather than in the extension
//!
//! The Lambda extension used to hold a Kafka credential and produce directly. That put a shared
//! secret inside every customer's execution environment (see `log_token.rs` for what that allowed),
//! and it made every sandbox a Kafka client:
//!
//! - **A TLS and SASL handshake per cold start**, to a broker in another datacentre, inside the
//!   customer's billed duration. SCRAM is several round trips before a byte of log moves.
//! - **A connection per concurrent sandbox.** Lambda's concurrency is the broker's connection
//!   count, which is a number neither we nor the customer control.
//! - **Kafka reachable from the internet**, because Lambda has no fixed egress.
//!
//! The router already exists, already runs on instances we own, and is already long-lived. One
//! producer here, held open, serves every sandbox: the handshake happens once per instance instead
//! of once per cold start, and the broker sees a handful of connections rather than thousands.
//!
//! ## The shape
//!
//! `POST /_sproutos/logs` with a bearer token and a JSON array of records. The handler verifies the
//! token, **stamps the project id from it**, derives billing from the organization bound into that
//! same token, and hands the log batch to a channel. A background task
//! owns the producer and drains that channel. The handler never waits for Kafka — a customer's
//! invocation must not be slowed by our log pipeline, and a broker hiccup must not turn into
//! backpressure on their application.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// The path the extension posts to.
///
/// Under `/_sproutos/` because everything else the router serves belongs to a customer's
/// application. A tenant hostname is a catch-all, so this prefix is reserved and is refused for
/// tenant traffic — see `serve.rs`.
pub const INGEST_PATH: &str = "/_sproutos/logs";

/// One log line as the extension sends it, and as ClickHouse reads it.
///
/// `project_id` and `deployment_id` are **not** here: the extension has no say in them. They are
/// written by [`stamp`] from the verified token, which is the difference between a log pipeline and
/// a way to write into someone else's bill.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IncomingRecord {
    pub ts: String,
    pub request_id: String,
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub billed_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_ms: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cold_start: Option<bool>,
}

/// What actually goes on the topic: the record, plus the attribution we decided.
#[derive(Debug, Clone, Serialize)]
pub struct StampedRecord {
    pub ts: String,
    pub project_id: String,
    pub deployment_id: String,
    pub request_id: String,
    pub level: String,
    pub message: String,
    pub duration_ms: Option<f32>,
    pub billed_ms: Option<u32>,
    pub memory_mb: Option<u16>,
    pub init_ms: Option<f32>,
    pub cold_start: Option<bool>,
}

/// Attribution comes from the token, never from the body.
///
/// This function is the security boundary in one line: whatever the caller said about whose logs
/// these are is discarded, and the project the token proved is written in its place.
pub fn stamp(record: IncomingRecord, project_id: &str, deployment_id: &str) -> StampedRecord {
    StampedRecord {
        ts: record.ts,
        project_id: project_id.to_owned(),
        deployment_id: deployment_id.to_owned(),
        request_id: record.request_id,
        level: record.level,
        message: record.message,
        duration_ms: record.duration_ms,
        billed_ms: record.billed_ms,
        memory_mb: record.memory_mb,
        init_ms: record.init_ms,
        cold_start: record.cold_start,
    }
}

/// How many batches may be waiting for Kafka before new ones are dropped.
///
/// Bounded on purpose. An unbounded channel in front of a broker that has stopped answering is a
/// memory leak with a plausible-sounding name, and the router's memory is shared with every
/// customer request it is proxying. Dropping logs is the cheaper failure — the alternative is the
/// front door running out of memory because ClickHouse is having a bad day.
pub const QUEUE_DEPTH: usize = 1024;

#[derive(Clone)]
pub struct LogSink {
    tx: mpsc::Sender<Vec<StampedRecord>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Accepted {
    /// Handed to the producer task.
    Queued(usize),
    /// The queue is full and the batch was dropped. Reported to the caller as success anyway —
    /// see [`LogSink::offer`].
    Dropped(usize),
}

impl LogSink {
    pub fn new(tx: mpsc::Sender<Vec<StampedRecord>>) -> Self {
        Self { tx }
    }

    /// Never blocks, never fails the caller.
    ///
    /// `try_send`, not `send`. The caller is a Lambda extension that is holding its own invocation
    /// open until we answer, on the customer's bill. Waiting here to preserve a log line spends
    /// their money to protect our telemetry, which is the wrong way round — and it is the same
    /// reasoning the extension itself uses when its buffer fills.
    pub fn offer(&self, batch: Vec<StampedRecord>) -> Accepted {
        let count = batch.len();
        match self.tx.try_send(batch) {
            Ok(()) => Accepted::Queued(count),
            Err(_) => Accepted::Dropped(count),
        }
    }
}

/// Pull the bearer token out of an `Authorization` header.
///
/// Case-insensitive on the scheme because the header's scheme is defined that way, and a client
/// sending `bearer` is not wrong.
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() { None } else { Some(token) }
}

/// The producer half: one connection, held open, draining the channel forever.
///
/// Separate from the handler so the two cannot deadlock and so a broker outage is invisible to
/// anything serving traffic. If the producer dies the channel fills, `offer` starts dropping, and
/// requests keep being served — degraded telemetry rather than a degraded platform.
pub struct Producer {
    inner: Arc<dyn ProduceBatch + Send + Sync>,
}

/// What the producer needs from Kafka, and all it needs — so the drain loop can be tested without
/// one. The real implementation lives in `kafka.rs`.
#[async_trait::async_trait]
pub trait ProduceBatch {
    async fn produce(&self, records: &[StampedRecord]) -> anyhow::Result<()>;
}

impl Producer {
    pub fn new(inner: Arc<dyn ProduceBatch + Send + Sync>) -> Self {
        Self { inner }
    }

    /// Drain until the channel closes.
    ///
    /// A failed produce is logged and the batch is dropped rather than retried in place. Retrying
    /// here would hold the loop on one bad batch while good ones queue behind it, and Kafka is
    /// already the buffer this pipeline has — a line that cannot be produced is a line that was
    /// going to be late enough to be useless anyway.
    pub async fn run(self, mut rx: mpsc::Receiver<Vec<StampedRecord>>) {
        while let Some(batch) = rx.recv().await {
            if batch.is_empty() {
                continue;
            }
            if let Err(cause) = self.inner.produce(&batch).await {
                tracing::error!(%cause, count = batch.len(), "could not produce runtime logs");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> IncomingRecord {
        IncomingRecord {
            ts: "2026-08-25 05:00:00.000".into(),
            request_id: "req-1".into(),
            level: "info".into(),
            message: "hello".into(),
            duration_ms: None,
            billed_ms: Some(13),
            memory_mb: Some(128),
            init_ms: None,
            cold_start: Some(false),
        }
    }

    /// The point of the whole module.
    #[test]
    fn attribution_comes_from_the_token() {
        let stamped = stamp(record(), "project-from-token", "deployment-from-token");
        assert_eq!(stamped.project_id, "project-from-token");
        assert_eq!(stamped.deployment_id, "deployment-from-token");
    }

    /// A payload cannot carry a project at all — there is no field to put one in. This asserts the
    /// *type* is the boundary, so a later refactor that adds one has to delete this test to pass.
    #[test]
    fn an_incoming_record_has_nowhere_to_claim_a_project() {
        let raw = r#"{"ts":"t","request_id":"r","level":"info","message":"m",
                      "project_id":"01a03b00-0000-7000-8000-00000000dead"}"#;
        let parsed: IncomingRecord = serde_json::from_str(raw).expect("parses");
        let stamped = stamp(parsed, "the-real-project", "d");
        assert_eq!(stamped.project_id, "the-real-project");
    }

    #[test]
    fn a_full_queue_drops_rather_than_blocking() {
        let (tx, _rx) = mpsc::channel(1);
        let sink = LogSink::new(tx);

        assert_eq!(
            sink.offer(vec![stamp(record(), "p", "d")]),
            Accepted::Queued(1)
        );
        // The receiver is never read, so the second offer finds the queue full.
        assert_eq!(
            sink.offer(vec![stamp(record(), "p", "d")]),
            Accepted::Dropped(1)
        );
    }

    #[test]
    fn reads_a_bearer_token_however_it_is_cased() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(None), None);
    }
}
