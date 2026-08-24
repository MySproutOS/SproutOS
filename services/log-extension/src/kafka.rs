//! Producing to the log topic.
//!
//! `rskafka` rather than `rdkafka`: this ships as a layer inside the customer's execution
//! environment, so a C dependency is a build toolchain and several megabytes charged to their cold
//! start — for a producer that writes JSON to one topic and never consumes.

use anyhow::Context as _;
use rskafka::client::ClientBuilder;
use rskafka::client::partition::{Compression, PartitionClient, UnknownTopicHandling};
use rskafka::record::Record;

pub struct Producer {
    partition: PartitionClient,
}

/// Which partition this function's logs go to.
///
/// Derived from the project so one project's lines land on one partition and arrive in order.
/// Unkeyed, Kafka round-robins and a `platform.report` can be consumed before the `platform.start`
/// of its own invocation — cosmetic in a log viewer, and not cosmetic at all when the report is
/// what the customer is billed from.
pub fn partition_for(project_id: &str, partitions: i32) -> i32 {
    let hash = project_id.bytes().fold(0u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u32)
    });
    (hash % partitions.max(1) as u32) as i32
}

pub async fn connect() -> anyhow::Result<Producer> {
    let brokers: Vec<String> = std::env::var("KAFKA_BROKERS")
        .context("KAFKA_BROKERS is not set; the extension has nowhere to send logs")?
        .split(',')
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect();

    let topic = std::env::var("KAFKA_RUNTIME_LOG_TOPIC").unwrap_or_else(|_| "runtime-logs".into());
    let partitions: i32 = std::env::var("KAFKA_RUNTIME_LOG_PARTITIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);

    let project_id = std::env::var("SPROUTOS_PROJECT_ID").unwrap_or_default();

    let client = ClientBuilder::new(brokers)
        .build()
        .await
        .context("could not reach Kafka")?;

    let partition = client
        .partition_client(
            topic,
            partition_for(&project_id, partitions),
            // The topic is created by `bin/bootstrap-kafka.sh`, deliberately. Auto-creation here
            // would turn a typo in the topic name into a second topic nobody consumes, and the
            // customer's logs would vanish with everything reporting success.
            UnknownTopicHandling::Error,
        )
        .await
        .context("could not open the log topic")?;

    Ok(Producer { partition })
}

impl Producer {
    pub async fn send(&self, messages: &[Vec<u8>]) -> anyhow::Result<()> {
        if messages.is_empty() {
            return Ok(());
        }

        let records: Vec<Record> = messages
            .iter()
            .map(|value| Record {
                key: None,
                value: Some(value.clone()),
                headers: Default::default(),
                timestamp: chrono::Utc::now(),
            })
            .collect();

        self.partition
            .produce(records, Compression::Lz4)
            .await
            .context("producing to the log topic failed")?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_one_project_to_one_partition() {
        // The ordering guarantee is per partition, so a project whose lines are spread across
        // partitions has no ordering at all — and the report a customer is billed from can be
        // consumed before the start of its own invocation.
        let project = "01a03600-0000-7000-8000-00000000d1ce";

        let first = partition_for(project, 3);
        for _ in 0..10 {
            assert_eq!(partition_for(project, 3), first);
        }
        assert!((0..3).contains(&first));
    }

    #[test]
    fn spreads_different_projects_across_partitions() {
        let assignments: std::collections::HashSet<i32> = (0..50)
            .map(|n| partition_for(&format!("01a03600-0000-7000-8000-0000000{n:05}"), 3))
            .collect();

        // Not a distribution test — just that it is not a constant. A hash that sent every project
        // to partition 0 would be correct and useless.
        assert!(assignments.len() > 1);
    }

    #[test]
    fn survives_a_partition_count_of_zero() {
        // A misconfigured `KAFKA_RUNTIME_LOG_PARTITIONS=0` must not be a division by zero that
        // takes the customer's function down with the extension.
        assert_eq!(partition_for("anything", 0), 0);
    }
}
