//! Durable search usage observed at the proxy/engine boundary.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use sproutos_llm_proxy::spool::{MeteringSpool, SpoolError};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use sproutos_tenant_auth::TenantIdentity;
use uuid::Uuid;

use crate::naming::prefix_for;
use crate::security::SecurityManager;

const SOURCE: &str = "search-proxy";
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
const HOUR_MS: i64 = 3_600_000;

#[derive(Debug, Clone)]
pub struct SearchMeter {
    spool: MeteringSpool,
}

#[derive(Debug, Clone)]
pub struct QueryObservation {
    pub request_id: String,
    identity: TenantIdentity,
    units: u64,
    occurred_at: i64,
}

impl QueryObservation {
    /// Stamp once before the upstream attempt. Security recovery reuses this observation and the
    /// fsynced spool reuses the resulting event on every delivery attempt.
    pub fn for_request(identity: &TenantIdentity, path: &str, body: &Bytes) -> Option<Self> {
        let units = query_units(path, body)?;
        Some(Self {
            request_id: Uuid::now_v7().simple().to_string(),
            identity: *identity,
            units,
            occurred_at: now_millis(),
        })
    }
}

impl SearchMeter {
    pub fn new(spool: MeteringSpool) -> Self {
        Self { spool }
    }

    pub fn record_query(&self, observation: &QueryObservation) {
        let event = UsageEvent::new(
            format!(
                "{SOURCE}:{}:es_search_unit:{}",
                observation.identity.resource_id, observation.request_id
            ),
            observation.identity.organization_id,
            UsageDimension::EsSearchUnit,
            observation.units as f64,
            observation.occurred_at,
        )
        .with_attribute(
            "search_index_id",
            observation.identity.resource_id.to_string(),
        );
        self.persist(&UsageBatch::new(SOURCE, vec![event]));
    }

    fn record_storage(&self, identity: &TenantIdentity, bytes: u64, occurred_at: i64) {
        if bytes == 0 {
            return;
        }
        let event = UsageEvent::new(
            format!(
                "{SOURCE}:{}:es_storage_gib_hour:{}",
                identity.resource_id,
                occurred_at / HOUR_MS
            ),
            identity.organization_id,
            UsageDimension::EsStorageGibHour,
            bytes as f64 / GIB,
            occurred_at,
        )
        .with_attribute("search_index_id", identity.resource_id.to_string());
        self.persist(&UsageBatch::new(SOURCE, vec![event]));
    }

    fn persist(&self, batch: &UsageBatch) {
        let reservation = match self.spool.reserve() {
            Ok(reservation) => reservation,
            Err(SpoolError::Full { .. }) => {
                tracing::error!(
                    source = SOURCE,
                    "search metering spool is full; serving without recording usage"
                );
                return;
            }
            Err(cause) => {
                tracing::error!(%cause, "search metering spool could not reserve capacity");
                return;
            }
        };
        if let Err(cause) = reservation.commit(batch) {
            tracing::error!(%cause, "search usage could not be committed to the durable spool");
        }
    }

    /// Sample each managed tenant at UTC hour boundaries. The stable resource/hour id makes
    /// multiple router instances converge under the at-least-once ClickHouse contract.
    pub fn spawn_storage_sampling(
        &self,
        security: SecurityManager,
        client: reqwest::Client,
        upstream: String,
    ) -> tokio::task::JoinHandle<()> {
        let meter = self.clone();
        tokio::spawn(async move {
            loop {
                let now = now_millis();
                let boundary = (now.div_euclid(HOUR_MS) + 1) * HOUR_MS;
                tokio::time::sleep(Duration::from_millis((boundary - now) as u64)).await;
                meter
                    .sample_storage_at(&security, &client, &upstream, boundary)
                    .await;
            }
        })
    }

    /// Execute one hour-boundary sample. Public so integration and operational verification can
    /// drive the exact same authenticated `_stats` request as the scheduler.
    pub async fn sample_storage_at(
        &self,
        security: &SecurityManager,
        client: &reqwest::Client,
        upstream: &str,
        occurred_at: i64,
    ) {
        let tenants = match security.managed_tenants().await {
            Ok(tenants) => tenants,
            Err(cause) => {
                tracing::error!(%cause, "search storage tenant enumeration failed");
                return;
            }
        };
        for tenant in tenants {
            let prefix = prefix_for(&tenant);
            let credentials = security.credentials_for(&tenant, &prefix);
            let url = format!(
                "{}/{}*/_stats/store?filter_path=_all.primaries.store.size_in_bytes",
                upstream.trim_end_matches('/'),
                prefix
            );
            let response = client
                .get(url)
                .basic_auth(&credentials.user, Some(&credentials.password))
                .send()
                .await;
            let bytes = match response {
                Ok(response) if response.status().is_success() => response
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|body| primary_store_bytes(&body)),
                Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => Some(0),
                Ok(response) => {
                    tracing::error!(tenant = %tenant, status = %response.status(), "search storage sample refused");
                    None
                }
                Err(cause) => {
                    tracing::error!(tenant = %tenant, %cause, "search storage sample failed");
                    None
                }
            };
            if let Some(bytes) = bytes {
                self.record_storage(&tenant, bytes, occurred_at);
            } else {
                tracing::error!(tenant = %tenant, "search storage response had no primary byte count");
            }
        }
    }
}

/// OpenSearch omits `_all` entirely when an index wildcard matches no indices. That is a valid
/// zero-byte sample, not a malformed response. Require the complete zero-shard summary before
/// accepting the omission so a changed or partially filtered response still fails visibly.
fn primary_store_bytes(body: &serde_json::Value) -> Option<u64> {
    if let Some(all) = body.get("_all") {
        // Once `_all` is present, it is the authoritative result. Do not reinterpret a malformed
        // or partially filtered `_all` object as the separate, valid no-indices response.
        return all
            .pointer("/primaries/store/size_in_bytes")
            .and_then(serde_json::Value::as_u64);
    }

    let shards = body.get("_shards")?;
    (shards.get("total")?.as_u64()? == 0
        && shards.get("successful")?.as_u64()? == 0
        && shards.get("failed")?.as_u64()? == 0)
        .then_some(0)
}

fn query_units(path: &str, body: &Bytes) -> Option<u64> {
    let endpoint = path.trim_end_matches('/').rsplit('/').next()?;
    match endpoint {
        "_search" | "_count" => Some(1),
        "_msearch" => {
            let lines = body
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .count();
            u64::try_from(lines / 2).ok().filter(|units| *units > 0)
        }
        _ => None,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use sproutos_llm_proxy::spool::SpoolLimits;
    use sproutos_tenant_auth::ResourceKind;

    use super::*;

    fn fixture() -> (SearchMeter, MeteringSpool, std::path::PathBuf) {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "sproutos-search-meter-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let spool = MeteringSpool::open(&path, SpoolLimits::default()).unwrap();
        (SearchMeter::new(spool.clone()), spool, path)
    }

    fn tenant() -> TenantIdentity {
        TenantIdentity::new(
            "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f".parse().unwrap(),
            ResourceKind::SearchIndex,
            "01912d41-0000-7000-8000-0000000000b1".parse().unwrap(),
        )
    }

    fn only_batch(path: &std::path::Path) -> UsageBatch {
        let record = fs::read_dir(path).unwrap().next().unwrap().unwrap().path();
        serde_json::from_slice(&fs::read(record).unwrap()).unwrap()
    }

    #[test]
    fn only_executing_endpoints_have_query_units() {
        assert_eq!(query_units("/t_x_products/_search", &Bytes::new()), Some(1));
        assert_eq!(query_units("/t_x_products/_count", &Bytes::new()), Some(1));
        assert_eq!(
            query_units("/_msearch", &Bytes::from_static(b"{}\n{}\n{}\n{}\n")),
            Some(2)
        );
        assert_eq!(query_units("/t_x_products/_doc/1", &Bytes::new()), None);
    }

    #[test]
    fn empty_index_wildcard_is_a_valid_zero_byte_sample() {
        let empty = serde_json::json!({
            "_shards": { "total": 0, "successful": 0, "skipped": 0, "failed": 0 }
        });
        assert_eq!(primary_store_bytes(&empty), Some(0));

        let populated = serde_json::json!({
            "_all": { "primaries": { "store": { "size_in_bytes": 4096 } } },
            "_shards": { "total": 1, "successful": 1, "failed": 0 }
        });
        assert_eq!(primary_store_bytes(&populated), Some(4096));

        for malformed_or_partial in [
            serde_json::json!({}),
            serde_json::json!({ "_shards": { "total": 0 } }),
            serde_json::json!({ "_shards": { "successful": 0, "failed": 0 } }),
            serde_json::json!({ "_shards": { "total": 0, "failed": 0 } }),
            serde_json::json!({ "_shards": { "total": 0, "successful": 0 } }),
            serde_json::json!({
                "_shards": { "total": 1, "successful": 0, "failed": 1 }
            }),
            serde_json::json!({
                "_all": {},
                "_shards": { "total": 0, "successful": 0, "failed": 0 }
            }),
            serde_json::json!({
                "_all": { "primaries": { "store": { "size_in_bytes": "0" } } },
                "_shards": { "total": 0, "successful": 0, "failed": 0 }
            }),
        ] {
            assert_eq!(primary_store_bytes(&malformed_or_partial), None);
        }
    }

    #[test]
    fn query_stamp_and_storage_window_are_preserved_in_the_spool() {
        let (meter, spool, path) = fixture();
        let observation = QueryObservation {
            request_id: "executed-request-7".into(),
            identity: tenant(),
            units: 2,
            occurred_at: 1_723_459_260_123,
        };
        meter.record_query(&observation);
        assert_eq!(spool.pending_records(), 1);
        let batch = only_batch(&path);
        assert_eq!(batch.events[0].dimension, UsageDimension::EsSearchUnit);
        assert_eq!(batch.events[0].quantity, 2.0);
        assert_eq!(batch.events[0].occurred_at, 1_723_459_260_123);
        assert!(batch.events[0].external_id.ends_with("executed-request-7"));
        fs::remove_dir_all(path).unwrap();

        let (meter, spool, path) = fixture();
        meter.record_storage(&tenant(), 3 * 1024 * 1024 * 1024, 1_723_460_400_000);
        assert_eq!(spool.pending_records(), 1);
        let batch = only_batch(&path);
        assert_eq!(batch.events[0].dimension, UsageDimension::EsStorageGibHour);
        assert_eq!(batch.events[0].quantity, 3.0);
        assert_eq!(batch.events[0].occurred_at, 1_723_460_400_000);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn full_spool_fails_open() {
        let path = std::env::temp_dir().join(format!("sproutos-search-full-{}", Uuid::now_v7()));
        let spool = MeteringSpool::open(
            &path,
            SpoolLimits {
                max_records: 1,
                max_bytes: 1024 * 1024,
            },
        )
        .unwrap();
        let meter = SearchMeter::new(spool.clone());
        meter.record_storage(&tenant(), 1024, HOUR_MS);
        meter.record_storage(&tenant(), 2048, 2 * HOUR_MS);
        assert_eq!(spool.pending_records(), 1);
        fs::remove_dir_all(path).unwrap();
    }
}
