//! A bounded, durable handoff between token counting and metering ingest.
//!
//! Capacity is reserved before a model request is sent upstream. That ordering is load-bearing:
//! once the provider starts work, refusing to record the resulting usage is no longer honest
//! backpressure. Completed records are fsynced and atomically renamed before the reservation is
//! released, then retained until ingest acknowledges them with a successful HTTP response.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest as _, Sha256};
use sproutos_metering_proto::UsageBatch;
use tokio::task::JoinHandle;

const RECORD_EXTENSION: &str = "json";
const MAX_RECORD_BYTES: u64 = 16 * 1024;
pub const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_RECORDS: usize = 10_000;
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(2);
pub const DEFAULT_DELIVERY_BATCH_RECORDS: usize = 100;

#[derive(Debug, Clone, Copy)]
pub struct SpoolLimits {
    pub max_bytes: u64,
    pub max_records: usize,
}

impl Default for SpoolLimits {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_MAX_BYTES,
            max_records: DEFAULT_MAX_RECORDS,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    #[error("could not access the metering spool at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(
        "the metering spool is full ({records}/{max_records} records, {bytes}/{max_bytes} bytes)"
    )]
    Full {
        records: usize,
        max_records: usize,
        bytes: u64,
        max_bytes: u64,
    },
    #[error("the usage batch is invalid: {0}")]
    InvalidBatch(String),
    #[error("the encoded usage batch is {actual} bytes; the per-record limit is {maximum}")]
    RecordTooLarge { actual: u64, maximum: u64 },
}

#[derive(Debug, Clone)]
pub struct DeliveryConfig {
    pub client: reqwest::Client,
    pub ingest_url: String,
    pub metering_key: Vec<u8>,
    pub request_timeout: Duration,
    pub retry_delay: Duration,
}

impl DeliveryConfig {
    pub fn new(client: reqwest::Client, ingest_url: String, metering_key: Vec<u8>) -> Self {
        Self {
            client,
            ingest_url,
            metering_key,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            retry_delay: DEFAULT_RETRY_DELAY,
        }
    }
}

#[derive(Debug, Default)]
struct Capacity {
    stored_bytes: u64,
    stored_records: usize,
    reserved_bytes: u64,
    reserved_records: usize,
}

#[derive(Debug)]
struct Inner {
    directory: PathBuf,
    limits: SpoolLimits,
    capacity: Mutex<Capacity>,
    io: Mutex<()>,
    wake: tokio::sync::Notify,
}

#[derive(Debug, Clone)]
pub struct MeteringSpool {
    inner: Arc<Inner>,
}

impl MeteringSpool {
    pub fn open(directory: impl Into<PathBuf>, limits: SpoolLimits) -> Result<Self, SpoolError> {
        let directory = directory.into();
        fs::create_dir_all(&directory).map_err(|source| io_error(&directory, source))?;

        let mut capacity = Capacity::default();
        for entry in fs::read_dir(&directory).map_err(|source| io_error(&directory, source))? {
            let entry = entry.map_err(|source| io_error(&directory, source))?;
            if is_temporary(&entry.path()) {
                // A process can die between creating and renaming a record. A temporary file was
                // never committed and carries no usable batch; leaving it would evade capacity
                // accounting and eventually fill the disk.
                fs::remove_file(entry.path()).map_err(|source| io_error(entry.path(), source))?;
                continue;
            }
            if !is_record(&entry.path()) {
                continue;
            }
            let metadata = entry
                .metadata()
                .map_err(|source| io_error(entry.path(), source))?;
            capacity.stored_records += 1;
            capacity.stored_bytes = capacity.stored_bytes.saturating_add(metadata.len());
        }

        if capacity.stored_records > limits.max_records || capacity.stored_bytes > limits.max_bytes
        {
            return Err(SpoolError::Full {
                records: capacity.stored_records,
                max_records: limits.max_records,
                bytes: capacity.stored_bytes,
                max_bytes: limits.max_bytes,
            });
        }

        Ok(Self {
            inner: Arc::new(Inner {
                directory,
                limits,
                capacity: Mutex::new(capacity),
                io: Mutex::new(()),
                wake: tokio::sync::Notify::new(),
            }),
        })
    }

    /// Reserve worst-case record capacity before allowing a billable request upstream.
    pub fn reserve(&self) -> Result<SpoolReservation, SpoolError> {
        let mut capacity = self
            .inner
            .capacity
            .lock()
            .unwrap_or_else(|it| it.into_inner());
        let records = capacity.stored_records + capacity.reserved_records;
        let bytes = capacity.stored_bytes + capacity.reserved_bytes;
        if records >= self.inner.limits.max_records
            || bytes.saturating_add(MAX_RECORD_BYTES) > self.inner.limits.max_bytes
        {
            return Err(SpoolError::Full {
                records,
                max_records: self.inner.limits.max_records,
                bytes,
                max_bytes: self.inner.limits.max_bytes,
            });
        }
        capacity.reserved_records += 1;
        capacity.reserved_bytes += MAX_RECORD_BYTES;
        drop(capacity);
        Ok(SpoolReservation {
            spool: self.clone(),
            active: true,
        })
    }

    pub fn pending_records(&self) -> usize {
        self.inner
            .capacity
            .lock()
            .unwrap_or_else(|it| it.into_inner())
            .stored_records
    }

    /// Start the retry loop. Existing records are scanned immediately, which is the restart path.
    pub fn spawn_delivery(&self, config: DeliveryConfig) -> JoinHandle<()> {
        let spool = self.clone();
        tokio::spawn(async move { spool.delivery_loop(config).await })
    }

    async fn delivery_loop(self, config: DeliveryConfig) {
        loop {
            if let Err(cause) = self.deliver_available(&config).await {
                tracing::error!(%cause, "metering delivery failed; the durable batch will be retried");
            }

            tokio::select! {
                () = self.inner.wake.notified() => {},
                () = tokio::time::sleep(config.retry_delay) => {},
            }
        }
    }

    async fn deliver_available(&self, config: &DeliveryConfig) -> Result<(), DeliveryError> {
        loop {
            let paths = self.next_records(DEFAULT_DELIVERY_BATCH_RECORDS)?;
            if paths.is_empty() {
                return Ok(());
            }
            let mut stored = Vec::with_capacity(paths.len());
            let mut source = None;
            let mut events = Vec::new();
            for path in paths {
                let encoded = fs::read(&path).map_err(|source| DeliveryError::Io {
                    path: path.clone(),
                    source,
                })?;
                let batch: UsageBatch = serde_json::from_slice(&encoded)
                    .map_err(|cause| DeliveryError::Malformed(path.clone(), cause.to_string()))?;
                batch
                    .validate()
                    .map_err(|cause| DeliveryError::Malformed(path.clone(), cause.to_string()))?;
                if source
                    .as_ref()
                    .is_some_and(|expected| expected != &batch.source)
                {
                    return Err(DeliveryError::Malformed(
                        path,
                        "one delivery batch cannot mix emitter sources".into(),
                    ));
                }
                source.get_or_insert(batch.source);
                events.extend(batch.events);
                stored.push((path, encoded.len() as u64));
            }
            let batch = UsageBatch::new(
                source.expect("at least one durable record supplies a source"),
                events,
            );
            let encoded = serde_json::to_vec(&batch)
                .map_err(|cause| DeliveryError::Encode(cause.to_string()))?;

            let signature = sproutos_metering_proto::sign(&batch, &config.metering_key);
            let sent = tokio::time::timeout(
                config.request_timeout,
                config
                    .client
                    .post(&config.ingest_url)
                    .header("x-metering-signature", signature)
                    .body(encoded)
                    .header("content-type", "application/json")
                    .send(),
            )
            .await
            .map_err(|_| DeliveryError::Timeout(config.request_timeout))?
            .map_err(DeliveryError::Http)?;

            if !sent.status().is_success() {
                return Err(DeliveryError::Refused(sent.status()));
            }
            // If the process dies halfway through these removals, already-removed records were
            // acknowledged and remaining records replay idempotently. There is no lossy ordering.
            for (path, bytes) in stored {
                self.acknowledge(&path, bytes)?;
            }
        }
    }

    fn next_records(&self, limit: usize) -> Result<Vec<PathBuf>, DeliveryError> {
        let _guard = self.inner.io.lock().unwrap_or_else(|it| it.into_inner());
        let entries = fs::read_dir(&self.inner.directory).map_err(|source| DeliveryError::Io {
            path: self.inner.directory.clone(),
            source,
        })?;
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| DeliveryError::Io {
                path: self.inner.directory.clone(),
                source,
            })?;
            if is_record(&entry.path()) {
                records.push(entry.path());
            }
        }
        records.sort();
        records.truncate(limit);
        Ok(records)
    }

    fn acknowledge(&self, path: &Path, bytes: u64) -> Result<(), DeliveryError> {
        let _guard = self.inner.io.lock().unwrap_or_else(|it| it.into_inner());
        fs::remove_file(path).map_err(|source| DeliveryError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        sync_directory(&self.inner.directory).map_err(|source| DeliveryError::Io {
            path: self.inner.directory.clone(),
            source,
        })?;
        let mut capacity = self
            .inner
            .capacity
            .lock()
            .unwrap_or_else(|it| it.into_inner());
        capacity.stored_records = capacity.stored_records.saturating_sub(1);
        capacity.stored_bytes = capacity.stored_bytes.saturating_sub(bytes);
        Ok(())
    }
}

pub struct SpoolReservation {
    spool: MeteringSpool,
    active: bool,
}

impl SpoolReservation {
    /// Persist the once-stamped batch. The final file name is a digest of its canonical identity,
    /// so two attempts to enqueue the same observation converge on one durable record.
    pub fn commit(mut self, batch: &UsageBatch) -> Result<(), SpoolError> {
        batch
            .validate()
            .map_err(|source| SpoolError::InvalidBatch(source.to_string()))?;
        let encoded = serde_json::to_vec(batch)
            .map_err(|source| SpoolError::InvalidBatch(source.to_string()))?;
        let actual = encoded.len() as u64;
        if actual > MAX_RECORD_BYTES {
            return Err(SpoolError::RecordTooLarge {
                actual,
                maximum: MAX_RECORD_BYTES,
            });
        }

        let digest = Sha256::digest(sproutos_metering_proto::canonical(batch).as_bytes());
        let name = format!("{}.json", hex_lower(&digest));
        let final_path = self.spool.inner.directory.join(name);
        let temporary_path = self.spool.inner.directory.join(format!(
            ".{}.{}.tmp",
            std::process::id(),
            hex_lower(&digest)
        ));

        let _guard = self
            .spool
            .inner
            .io
            .lock()
            .unwrap_or_else(|it| it.into_inner());
        let (inserted, directory_sync) = if final_path.exists() {
            (false, Ok(()))
        } else {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)
                .map_err(|source| io_error(&temporary_path, source))?;
            if let Err(source) = file.write_all(&encoded).and_then(|()| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&temporary_path);
                return Err(io_error(&temporary_path, source));
            }
            drop(file);
            if let Err(source) = fs::rename(&temporary_path, &final_path) {
                let _ = fs::remove_file(&temporary_path);
                return Err(io_error(&final_path, source));
            }
            (true, sync_directory(&self.spool.inner.directory))
        };

        let mut capacity = self
            .spool
            .inner
            .capacity
            .lock()
            .unwrap_or_else(|it| it.into_inner());
        capacity.reserved_records -= 1;
        capacity.reserved_bytes -= MAX_RECORD_BYTES;
        if inserted {
            capacity.stored_records += 1;
            capacity.stored_bytes += actual;
        }
        self.active = false;
        drop(capacity);
        drop(_guard);
        self.spool.inner.wake.notify_one();
        directory_sync.map_err(|source| io_error(&self.spool.inner.directory, source))
    }
}

impl Drop for SpoolReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut capacity = self
            .spool
            .inner
            .capacity
            .lock()
            .unwrap_or_else(|it| it.into_inner());
        capacity.reserved_records = capacity.reserved_records.saturating_sub(1);
        capacity.reserved_bytes = capacity.reserved_bytes.saturating_sub(MAX_RECORD_BYTES);
    }
}

#[derive(Debug, thiserror::Error)]
enum DeliveryError {
    #[error("could not access metering spool record {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("metering spool record {0} is malformed: {1}")]
    Malformed(PathBuf, String),
    #[error("could not encode a metering delivery batch: {0}")]
    Encode(String),
    #[error("metering ingest request failed: {0}")]
    Http(reqwest::Error),
    #[error("metering ingest did not answer within {0:?}")]
    Timeout(Duration),
    #[error("metering ingest refused the durable batch with {0}")]
    Refused(reqwest::StatusCode),
}

fn is_record(path: &Path) -> bool {
    path.extension().and_then(|it| it.to_str()) == Some(RECORD_EXTENSION)
}

fn is_temporary(path: &Path) -> bool {
    path.file_name()
        .and_then(|it| it.to_str())
        .is_some_and(|it| it.starts_with('.') && it.ends_with(".tmp"))
}

fn sync_directory(directory: &Path) -> io::Result<()> {
    File::open(directory)?.sync_all()
}

fn io_error(path: impl Into<PathBuf>, source: io::Error) -> SpoolError {
    SpoolError::Io {
        path: path.into(),
        source,
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use sproutos_metering_proto::{UsageDimension, UsageEvent};

    use super::*;

    #[derive(Default)]
    struct Ingest {
        available: AtomicBool,
        attempts: AtomicUsize,
        bodies: Mutex<Vec<Vec<u8>>>,
    }

    async fn ingest(State(state): State<Arc<Ingest>>, body: Bytes) -> StatusCode {
        state.attempts.fetch_add(1, Ordering::SeqCst);
        state.bodies.lock().unwrap().push(body.to_vec());
        if state.available.load(Ordering::SeqCst) {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        }
    }

    fn batch_at(request: &str, occurred_at: i64) -> UsageBatch {
        let mut event = UsageEvent::new(
            format!("llm-proxy:token-1:{request}:AiInputToken"),
            "01a03b00-0000-7000-8000-00000000beef".parse().unwrap(),
            UsageDimension::AiInputToken,
            41.0,
            occurred_at,
        );
        event.project_id = Some("01a03b96-a3d3-71f5-9f1d-af7569938433".parse().unwrap());
        UsageBatch::new("llm-proxy", vec![event])
    }

    fn batch() -> UsageBatch {
        batch_at("req-1", 1_700_000_000_123)
    }

    fn temporary_directory(name: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "sproutos-llm-spool-{}-{name}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..100 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition did not become true");
    }

    #[tokio::test]
    async fn outage_restart_and_replay_keep_the_once_stamped_batch() {
        let directory = temporary_directory("restart");
        let state = Arc::new(Ingest::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/metering", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/metering", post(ingest))
            .with_state(Arc::clone(&state));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let first = MeteringSpool::open(&directory, SpoolLimits::default()).unwrap();
        first.reserve().unwrap().commit(&batch()).unwrap();
        first
            .reserve()
            .unwrap()
            .commit(&batch_at("req-2", 1_700_000_000_456))
            .unwrap();
        let mut delivery = DeliveryConfig::new(
            reqwest::Client::new(),
            url.clone(),
            b"metering-key".to_vec(),
        );
        delivery.retry_delay = Duration::from_millis(20);
        delivery.request_timeout = Duration::from_secs(1);
        let first_worker = first.spawn_delivery(delivery.clone());
        wait_until(|| state.attempts.load(Ordering::SeqCst) >= 1).await;
        assert_eq!(
            first.pending_records(),
            2,
            "a refused batch must remain durable"
        );
        first_worker.abort();
        first_worker.await.unwrap_err();
        drop(first);

        // Opening the same directory is the process-restart boundary. No in-memory queue survives.
        state.available.store(true, Ordering::SeqCst);
        let restarted = MeteringSpool::open(&directory, SpoolLimits::default()).unwrap();
        assert_eq!(restarted.pending_records(), 2);
        let second_worker = restarted.spawn_delivery(delivery);
        wait_until(|| restarted.pending_records() == 0).await;

        let bodies = state.bodies.lock().unwrap();
        assert!(bodies.len() >= 2, "the outage must cause a replay");
        assert_eq!(bodies.first(), bodies.last(), "retry bytes changed");
        let replayed: UsageBatch = serde_json::from_slice(bodies.last().unwrap()).unwrap();
        assert_eq!(
            replayed.events.len(),
            2,
            "durable turns should be batched across delivery"
        );
        let first_turn = replayed
            .events
            .iter()
            .find(|event| event.external_id == "llm-proxy:token-1:req-1:AiInputToken")
            .expect("the first turn should survive restart");
        assert_eq!(first_turn.occurred_at, 1_700_000_000_123);
        drop(bodies);

        second_worker.abort();
        server.abort();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bounded_capacity_refuses_work_before_it_can_become_unrecorded_usage() {
        let directory = temporary_directory("bounded");
        let spool = MeteringSpool::open(
            &directory,
            SpoolLimits {
                max_bytes: MAX_RECORD_BYTES * 2,
                max_records: 1,
            },
        )
        .unwrap();

        let reservation = spool.reserve().unwrap();
        assert!(matches!(spool.reserve(), Err(SpoolError::Full { .. })));
        reservation.commit(&batch()).unwrap();
        assert!(matches!(spool.reserve(), Err(SpoolError::Full { .. })));
        assert_eq!(spool.pending_records(), 1);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn an_uncommitted_empty_turn_releases_its_reservation() {
        let directory = temporary_directory("empty");
        let spool = MeteringSpool::open(
            &directory,
            SpoolLimits {
                max_bytes: MAX_RECORD_BYTES,
                max_records: 1,
            },
        )
        .unwrap();
        drop(spool.reserve().unwrap());
        spool.reserve().unwrap();
        assert_eq!(spool.pending_records(), 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
