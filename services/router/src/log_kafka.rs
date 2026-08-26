//! The one Kafka connection this process owns.
//!
//! `rskafka` for the same reason the extension used it: a pure-Rust client, no librdkafka, no C
//! toolchain in the build. The difference is where it runs. In the extension this producer was
//! constructed per execution environment and handshook on every cold start; here it is constructed
//! once per router instance and held for the life of the process.

use std::sync::Arc;

use anyhow::Context as _;
use rskafka::client::partition::{Compression, PartitionClient, UnknownTopicHandling};
use rskafka::client::{ClientBuilder, Credentials, SaslConfig};
use rskafka::record::Record;

use crate::logs::{ProduceBatch, StampedRecord};

/// Partitions are chosen by project, so one project's lines stay in order.
///
/// Byte-for-byte the same function the extension used, and it has to be: a change on one side
/// scatters a project's logs across partitions and a `platform.report` can then be consumed before
/// the `platform.start` of its own invocation. Cosmetic in a viewer, and not cosmetic at all when
/// the report is what the customer is billed from.
pub fn partition_for(project_id: &str, partitions: i32) -> i32 {
    let hash = project_id.bytes().fold(0u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    (hash % partitions.max(1) as u32) as i32
}

pub struct KafkaProducer {
    partitions: Vec<PartitionClient>,
}

/// How long a connection may take before it is a misconfiguration rather than a slow network.
///
/// Generous for a handshake and short beside a deploy: the thing being caught is a client waiting
/// forever, not a broker taking its time.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

impl KafkaProducer {
    /// Connect once, and open a client for every partition.
    ///
    /// Every partition up front rather than on demand: this process produces for *all* projects, so
    /// it will need all of them, and discovering that lazily means the first line for some project
    /// pays a metadata round trip that the second never does.
    pub async fn connect() -> anyhow::Result<Self> {
        let brokers: Vec<String> = std::env::var("KAFKA_BROKERS")
            .context("KAFKA_BROKERS is not set; the router has nowhere to send runtime logs")?
            .split(',')
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect();

        let topic =
            std::env::var("KAFKA_RUNTIME_LOG_TOPIC").unwrap_or_else(|_| "runtime-logs".into());
        let partition_count: i32 = std::env::var("KAFKA_RUNTIME_LOG_PARTITIONS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3);

        let mut builder = ClientBuilder::new(brokers);

        /*
          TLS and SASL, and now the credential lives only here.

          This is the same authenticated connection the extension used to make — the difference is
          that the secret is on an instance we operate rather than inside every customer's execution
          environment. Kafka's ACL still restricts it to writing one topic; what changed is who can
          read the thing that opens it.
        */
        if let Ok(username) = std::env::var("KAFKA_SASL_USERNAME")
            && !username.is_empty()
        {
            let password = std::env::var("KAFKA_SASL_PASSWORD")
                .context("KAFKA_SASL_USERNAME is set but KAFKA_SASL_PASSWORD is not")?;

            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

            builder = builder
                .tls_config(Arc::new(
                    rustls::ClientConfig::builder()
                        .with_root_certificates(roots)
                        .with_no_client_auth(),
                ))
                .sasl_config(SaslConfig::ScramSha512(Credentials::new(
                    username, password,
                )));
        }

        /*
          Bounded, because the failure it replaces is a hang.

          `build()` negotiates a connection and has no timeout of its own. Point a TLS-and-SASL
          client at a plaintext listener — a broker configured one way and a `KAFKA_SASL_USERNAME`
          set the other — and the ClientHello sits in the broker's receive buffer as a 369 MB
          length prefix; the broker closes the connection and the client waits for a handshake that
          will never arrive. Observed here for ten minutes, against a local broker, with the cause
          visible only in the broker's own log as `InvalidReceiveException`.

          A router that cannot reach Kafka should fail its health check and say why. A router that
          hangs at boot is an Auto Scaling group replacing instances with no error anywhere.
        */
        let client = tokio::time::timeout(CONNECT_TIMEOUT, builder.build())
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "Kafka did not complete a connection within {}s. If `KAFKA_SASL_USERNAME` is \
                     set, this client speaks TLS — check the broker is not a plaintext listener.",
                    CONNECT_TIMEOUT.as_secs()
                )
            })?
            .context("could not reach Kafka")?;

        let mut partitions = Vec::with_capacity(partition_count.max(1) as usize);
        for index in 0..partition_count.max(1) {
            partitions.push(
                client
                    .partition_client(topic.clone(), index, UnknownTopicHandling::Error)
                    .await
                    .with_context(|| format!("could not open partition {index} of {topic}"))?,
            );
        }

        Ok(Self { partitions })
    }
}

#[async_trait::async_trait]
impl ProduceBatch for KafkaProducer {
    async fn produce(&self, records: &[StampedRecord]) -> anyhow::Result<()> {
        // Grouped by partition so a mixed batch — which every batch is, since this router serves
        // every project — becomes one produce call per partition rather than one per record.
        let count = self.partitions.len() as i32;
        let mut grouped: Vec<Vec<Record>> = vec![Vec::new(); self.partitions.len()];

        for record in records {
            let index = partition_for(&record.project_id, count) as usize;
            grouped[index].push(Record {
                key: None,
                value: Some(serde_json::to_vec(record)?),
                headers: Default::default(),
                timestamp: chrono::Utc::now(),
            });
        }

        for (index, batch) in grouped.into_iter().enumerate() {
            if batch.is_empty() {
                continue;
            }
            self.partitions[index]
                .produce(batch, Compression::Lz4)
                .await
                .with_context(|| format!("producing to partition {index}"))?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The extension used to compute this and now the router does. Same inputs, same answers, or a
    /// project's logs move partition the day the code moved process.
    #[test]
    fn partitions_match_the_extensions_old_answers() {
        assert_eq!(partition_for("01a03b00-0000-7000-8000-00000000beef", 3), 2);
        assert_eq!(partition_for("", 3), 0);
    }

    /// A misconfigured partition count must not be a division by zero that takes the router down.
    #[test]
    fn a_zero_partition_count_is_survivable() {
        assert_eq!(partition_for("anything", 0), 0);
    }
}
