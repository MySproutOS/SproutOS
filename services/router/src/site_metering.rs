//! Durable site usage observed at the trusted router boundary.
//!
//! Runtime compute is derived from Lambda's `platform.report` fields after the log token has
//! supplied the organization and project. Egress is counted after the Lambda response body has
//! been decoded. Both use the same fsynced spool as model metering, but a separate directory and
//! source so delivery batches never mix emitters.

use chrono::{DateTime, NaiveDateTime, Utc};
use sproutos_llm_proxy::spool::{MeteringSpool, SpoolError};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use uuid::Uuid;

use crate::log_token::Claims;
use crate::logs::StampedRecord;
use crate::route::Route;

const SOURCE: &str = "router-site";

#[derive(Debug, Clone)]
pub struct SiteMeter {
    spool: MeteringSpool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Stored,
    NotBillable,
    CapacityUnavailable,
}

impl SiteMeter {
    pub fn new(spool: MeteringSpool) -> Self {
        Self { spool }
    }

    /// Persist request and compute usage for every complete Lambda report in a log batch.
    ///
    /// A malformed or incomplete report remains a log but is not guessed into a bill. Capacity
    /// exhaustion is also fail-open: it is logged loudly and the extension still receives 202,
    /// because observability must never make a customer's invocation fail.
    pub fn record_reports(&self, claims: &Claims, records: &[StampedRecord]) -> Vec<Recorded> {
        records
            .iter()
            .filter(|record| record.billed_ms.is_some() || record.memory_mb.is_some())
            .map(|record| match report_batch(claims, record) {
                Some(batch) => self.persist(&batch),
                None => Recorded::NotBillable,
            })
            .collect()
    }

    /// Persist response-body egress without delaying or changing the response on failure.
    pub fn record_egress(
        &self,
        route: &Route,
        invocation_request_id: &str,
        bytes: usize,
        occurred_at: i64,
    ) -> Recorded {
        let (Ok(organization_id), Ok(project_id)) = (
            route.organization_id.parse::<Uuid>(),
            route.project_id.parse::<Uuid>(),
        ) else {
            tracing::error!(
                organization = route.organization_id,
                project = route.project_id,
                "route has invalid metering attribution; site egress was not recorded"
            );
            return Recorded::NotBillable;
        };
        if invocation_request_id.is_empty() {
            tracing::error!("Lambda returned no request id; site egress was not recorded");
            return Recorded::NotBillable;
        }

        let event = UsageEvent::new(
            format!(
                "router-site:lambda-invoke:{}:{invocation_request_id}:site_egress_byte",
                route.project_id
            ),
            organization_id,
            UsageDimension::SiteEgressByte,
            bytes as f64,
            occurred_at,
        )
        .with_project(project_id)
        .with_attribute("deployment_id", route.deployment_id.clone());
        self.persist(&UsageBatch::new(SOURCE, vec![event]))
    }

    fn persist(&self, batch: &UsageBatch) -> Recorded {
        let reservation = match self.spool.reserve() {
            Ok(reservation) => reservation,
            Err(SpoolError::Full { .. }) => {
                tracing::error!(
                    source = SOURCE,
                    events = batch.events.len(),
                    "site metering spool is full; serving traffic without recording this usage"
                );
                return Recorded::CapacityUnavailable;
            }
            Err(cause) => {
                tracing::error!(%cause, "site metering spool could not reserve capacity");
                return Recorded::CapacityUnavailable;
            }
        };
        match reservation.commit(batch) {
            Ok(()) => Recorded::Stored,
            Err(cause) => {
                tracing::error!(%cause, "site usage could not be committed to the durable spool");
                Recorded::CapacityUnavailable
            }
        }
    }
}

fn report_batch(claims: &Claims, record: &StampedRecord) -> Option<UsageBatch> {
    let organization_id = claims.organization_id.as_deref()?.parse::<Uuid>().ok()?;
    let project_id = claims.project_id.parse::<Uuid>().ok()?;
    let billed_ms = record.billed_ms?;
    let memory_mb = record.memory_mb?;
    if record.request_id.is_empty() {
        return None;
    }
    let occurred_at = timestamp_millis(&record.ts)?;
    let common = format!(
        "router-site:lambda-report:{}:{}",
        claims.project_id, record.request_id
    );
    let compute = UsageEvent::new(
        format!("{common}:site_gib_second"),
        organization_id,
        UsageDimension::SiteGibSecond,
        (f64::from(memory_mb) / 1024.0) * (f64::from(billed_ms) / 1000.0),
        occurred_at,
    )
    .with_project(project_id)
    .with_attribute("deployment_id", record.deployment_id.clone());
    let request = UsageEvent::new(
        format!("{common}:site_request"),
        organization_id,
        UsageDimension::SiteRequest,
        1.0,
        occurred_at,
    )
    .with_project(project_id)
    .with_attribute("deployment_id", record.deployment_id.clone());

    Some(UsageBatch::new(SOURCE, vec![compute, request]))
}

fn timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
                .map(|value| value.and_utc().timestamp_millis())
        })
        .ok()
}

pub fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use sproutos_llm_proxy::spool::SpoolLimits;

    use super::*;

    fn directory(name: &str) -> std::path::PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "sproutos-site-meter-{}-{name}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn claims() -> Claims {
        Claims {
            project_id: "01a03b00-0000-7000-8000-00000000beef".into(),
            organization_id: Some("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f".into()),
        }
    }

    fn report() -> StampedRecord {
        StampedRecord {
            ts: "2026-08-24 12:00:00.123".into(),
            ingested_at: "2026-08-24 12:00:01.000".into(),
            ingest_id: "A".repeat(32),
            project_id: claims().project_id,
            deployment_id: "01a03600-0000-7000-8000-0000000000de".into(),
            request_id: "lambda-request-1".into(),
            level: "platform".into(),
            message: "report".into(),
            duration_ms: Some(1.23),
            billed_ms: Some(220),
            memory_mb: Some(512),
            init_ms: Some(210.5),
            cold_start: Some(true),
        }
    }

    #[test]
    fn platform_report_becomes_stable_request_and_compute_events() {
        let path = directory("report");
        let spool = MeteringSpool::open(&path, SpoolLimits::default()).unwrap();
        let meter = SiteMeter::new(spool.clone());

        assert_eq!(
            meter.record_reports(&claims(), &[report()]),
            vec![Recorded::Stored]
        );
        assert_eq!(spool.pending_records(), 1);

        let raw = fs::read(fs::read_dir(&path).unwrap().next().unwrap().unwrap().path()).unwrap();
        let batch: UsageBatch = serde_json::from_slice(&raw).unwrap();
        assert_eq!(batch.source, SOURCE);
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].dimension, UsageDimension::SiteGibSecond);
        assert_eq!(batch.events[0].quantity, 0.11);
        assert_eq!(batch.events[0].occurred_at, 1_787_572_800_123);
        assert_eq!(batch.events[1].dimension, UsageDimension::SiteRequest);
        assert_eq!(batch.events[1].quantity, 1.0);

        // A replay converges on the same digest-named spool record.
        assert_eq!(
            meter.record_reports(&claims(), &[report()]),
            vec![Recorded::Stored]
        );
        assert_eq!(spool.pending_records(), 1);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn incomplete_reports_are_not_guessed_into_bills() {
        let path = directory("incomplete");
        let spool = MeteringSpool::open(&path, SpoolLimits::default()).unwrap();
        let meter = SiteMeter::new(spool.clone());
        let mut incomplete = report();
        incomplete.memory_mb = None;

        assert_eq!(
            meter.record_reports(&claims(), &[incomplete]),
            vec![Recorded::NotBillable]
        );
        assert_eq!(spool.pending_records(), 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn legacy_token_can_log_but_has_no_billing_owner_to_guess() {
        let path = directory("legacy");
        let spool = MeteringSpool::open(&path, SpoolLimits::default()).unwrap();
        let meter = SiteMeter::new(spool.clone());
        let legacy = Claims {
            project_id: claims().project_id,
            organization_id: None,
        };

        assert_eq!(
            meter.record_reports(&legacy, &[report()]),
            vec![Recorded::NotBillable]
        );
        assert_eq!(spool.pending_records(), 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn egress_uses_the_lambda_response_id_and_observation_timestamp() {
        let path = directory("egress");
        let spool = MeteringSpool::open(&path, SpoolLimits::default()).unwrap();
        let meter = SiteMeter::new(spool.clone());
        let identity = claims();
        let route = Route {
            arn: "arn".into(),
            project_id: identity.project_id,
            organization_id: identity.organization_id.unwrap(),
            deployment_id: "deployment-1".into(),
        };

        assert_eq!(
            meter.record_egress(&route, "aws-invoke-request-1", 4097, 1_787_572_801_234),
            Recorded::Stored
        );
        let raw = fs::read(fs::read_dir(&path).unwrap().next().unwrap().unwrap().path()).unwrap();
        let batch: UsageBatch = serde_json::from_slice(&raw).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].dimension, UsageDimension::SiteEgressByte);
        assert_eq!(batch.events[0].quantity, 4097.0);
        assert_eq!(batch.events[0].occurred_at, 1_787_572_801_234);
        assert!(batch.events[0].external_id.contains("aws-invoke-request-1"));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn full_spool_is_explicit_and_fail_open() {
        let path = directory("full");
        let spool = MeteringSpool::open(
            &path,
            SpoolLimits {
                max_bytes: 32 * 1024,
                max_records: 1,
            },
        )
        .unwrap();
        let meter = SiteMeter::new(spool.clone());

        assert_eq!(
            meter.record_reports(&claims(), &[report()]),
            vec![Recorded::Stored]
        );
        assert_eq!(
            meter.record_egress(
                &Route {
                    arn: "arn".into(),
                    project_id: claims().project_id,
                    organization_id: claims().organization_id.unwrap(),
                    deployment_id: "deployment".into(),
                },
                "invoke-request-2",
                400,
                1_777_118_401_000,
            ),
            Recorded::CapacityUnavailable
        );
        assert_eq!(spool.pending_records(), 1);
        fs::remove_dir_all(path).unwrap();
    }
}
