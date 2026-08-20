//! The `metering-agent` binary: a DaemonSet that samples cgroups and posts what it saw.
//!
//! Everything worth testing lives in the library half — the parsing, the deltas, the idempotency
//! keys, the retry buffer — so this file is the loop and the configuration, and nothing else.
//!
//! It samples on a fixed interval and posts on a longer one. Sampling every second keeps the memory
//! average honest; posting every second would be one request per node per second against the
//! control plane, which on a fleet is a denial of service we wrote ourselves.

use std::collections::BTreeMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use metering_agent::cgroup::{Attribution, Sample};
use metering_agent::{fs, ingest, sampler};
use tracing::{info, warn};

/// How often to read the cgroups.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

/// How often to ship what has been gathered.
const FLUSH_INTERVAL: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "metering_agent=info".into()),
        )
        .init();

    let node = fs::node_name().ok_or_else(|| {
        anyhow::anyhow!(
            "NODE_NAME is not set; every event carries it, and a fleet where half the events say \
             `unknown` cannot answer which node is overcharging"
        )
    })?;

    let endpoint = std::env::var("METERING_INGEST_URL")
        .map_err(|_| anyhow::anyhow!("METERING_INGEST_URL is not set"))?;
    let key = std::env::var("METERING_INGEST_HMAC_KEY")
        .map_err(|_| anyhow::anyhow!("METERING_INGEST_HMAC_KEY is not set"))?;

    let root = fs::root();
    let client = reqwest::Client::builder()
        // Shorter than the flush interval, so a hung control plane cannot stall the next sweep.
        .timeout(Duration::from_secs(10))
        .build()?;

    info!(%node, root = %root.display(), "metering-agent starting");

    let mut watched: BTreeMap<String, sampler::Watched> = BTreeMap::new();
    let mut pending = ingest::Pending::default();
    let mut last_sample = Instant::now();
    let mut last_flush = Instant::now();

    loop {
        tokio::time::sleep(SAMPLE_INTERVAL).await;

        let elapsed = last_sample.elapsed();
        last_sample = Instant::now();

        /*
            Pod labels come from the kubelet's own view, not from the API server.

            A per-node, per-second call to the control plane to ask who owns each pod is the design
            that takes an API server down at scale. Reading the annotations the kubelet already
            wrote costs nothing and cannot fail in a way that stops billing.

            Not wired yet: this reads an empty map, so the agent runs and bills nothing. The
            kubelet's pod-resources socket is the intended source and needs the DaemonSet's mounts,
            which do not exist. Said plainly rather than faked with a placeholder that looks like it
            works.
        */
        let labels: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

        let readings: BTreeMap<String, (Attribution, Sample)> = fs::read_all(&root, &labels)
            .into_iter()
            .map(|found| (found.name, (found.attribution, found.sample)))
            .collect();

        let now_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let sweep = sampler::sweep(&mut watched, &readings, elapsed, now_millis, &node);
        if sweep.rebaselined > 0 {
            // Counted, not logged per occurrence: a rolling deploy restarts every pod at once, and
            // a line each would bury the sweep that matters.
            info!(count = sweep.rebaselined, "re-baselined restarted cgroups");
        }
        pending.extend(sweep.events);

        if last_flush.elapsed() < FLUSH_INTERVAL || pending.is_empty() {
            continue;
        }
        last_flush = Instant::now();

        let events = pending.take();
        let count = events.len();
        let (batch, signature) = ingest::prepare(&node, events, key.as_bytes());

        match client
            .post(&endpoint)
            .header("x-metering-signature", &signature)
            .json(&batch)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                info!(count, "delivered");
            }
            Ok(response) => {
                /*
                    A 4xx is not retryable and a 5xx is, but both are held.

                    A rejected batch is either a bug in the signing or a schema drift, and in both
                    cases the events are still real money. Holding them means the fix is a deploy
                    rather than a reconciliation, and the idempotency keys make redelivery safe.
                */
                warn!(status = %response.status(), count, "ingest refused the batch; holding it");
                pending.restore(batch.events);
            }
            Err(cause) => {
                warn!(%cause, count, "could not reach ingest; holding the batch");
                pending.restore(batch.events);
            }
        }

        if pending.dropped > 0 {
            // Never silent. An agent that loses events without saying so is worse than one that
            // crashes, because the loss is invisible on both ends.
            warn!(
                dropped = pending.dropped,
                "the pending buffer has overflowed"
            );
        }
    }
}
