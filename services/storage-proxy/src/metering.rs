use sproutos_llm_proxy::spool::{MeteringSpool, SpoolError, SpoolReservation};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use sproutos_service_credentials::ResolvedService;
use uuid::Uuid;

const SOURCE: &str = "storage-proxy";

#[derive(Debug, Clone)]
pub struct StorageMeter {
    spool: MeteringSpool,
}

impl StorageMeter {
    pub fn new(spool: MeteringSpool) -> Self {
        Self { spool }
    }

    /// Reserve durable capacity before a request is sent to S3.
    pub fn begin(
        &self,
        service: ResolvedService,
        dimension: Option<UsageDimension>,
    ) -> Result<StorageUsage, SpoolError> {
        Ok(StorageUsage {
            reservation: Some(self.spool.reserve()?),
            service,
            dimension,
            request_id: Uuid::now_v7(),
            occurred_at: now_millis(),
            request_quantity: 1.0,
        })
    }
}

/// One forwarded S3 request and the response bytes it actually delivered.
pub struct StorageUsage {
    reservation: Option<SpoolReservation>,
    service: ResolvedService,
    dimension: Option<UsageDimension>,
    request_id: Uuid,
    occurred_at: i64,
    request_quantity: f64,
}

impl StorageUsage {
    pub fn with_request_quantity(mut self, quantity: f64) -> Self {
        self.request_quantity = quantity;
        self
    }

    pub fn commit(mut self, egress_bytes: u64) {
        let Some(reservation) = self.reservation.take() else {
            return;
        };
        let common = format!(
            "storage-proxy:{}:{}",
            self.service.backend_service_id, self.request_id
        );
        let mut events = Vec::with_capacity(2);
        if let Some(dimension) = self.dimension {
            let mut request = UsageEvent::new(
                format!("{common}:{}", dimension.as_str()),
                self.service.organization_id,
                dimension,
                self.request_quantity,
                self.occurred_at,
            )
            .with_attribute(
                "backend_service_id",
                self.service.backend_service_id.to_string(),
            );
            if let Some(project_id) = self.service.project_id {
                request = request.with_project(project_id);
            }
            events.push(request);
        }
        if egress_bytes > 0 {
            let mut egress = UsageEvent::new(
                format!("{common}:object_storage_egress_byte"),
                self.service.organization_id,
                UsageDimension::ObjectStorageEgressByte,
                egress_bytes as f64,
                self.occurred_at,
            )
            .with_attribute(
                "backend_service_id",
                self.service.backend_service_id.to_string(),
            );
            if let Some(project_id) = self.service.project_id {
                egress = egress.with_project(project_id);
            }
            events.push(egress);
        }

        // A free DELETE whose S3 response is empty has nothing to bill and releases its reservation.
        if events.is_empty() {
            return;
        }
        if let Err(cause) = reservation.commit(&UsageBatch::new(SOURCE, events)) {
            tracing::error!(%cause, "object-storage usage could not be committed to the durable spool");
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use sproutos_llm_proxy::spool::SpoolLimits;

    use super::*;

    fn resolved() -> ResolvedService {
        ResolvedService {
            credential_id: Some(Uuid::parse_str("01a03b00-0000-7000-8000-000000000001").unwrap()),
            backend_service_id: Uuid::parse_str("01a03b00-0000-7000-8000-000000000002").unwrap(),
            organization_id: Uuid::parse_str("01a03b00-0000-7000-8000-000000000003").unwrap(),
            project_id: Some(Uuid::parse_str("01a03b00-0000-7000-8000-000000000004").unwrap()),
            public_read: false,
        }
    }

    #[test]
    fn one_request_and_its_delivered_bytes_are_one_durable_batch() {
        let directory = tempfile::tempdir().unwrap();
        let spool = MeteringSpool::open(directory.path(), SpoolLimits::default()).unwrap();
        let meter = StorageMeter::new(spool.clone());

        meter
            .begin(resolved(), Some(UsageDimension::ObjectStorageReadRequest))
            .unwrap()
            .commit(1_234);

        assert_eq!(spool.pending_records(), 1);
        let path = fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let batch: UsageBatch = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(batch.source, SOURCE);
        assert_eq!(batch.events.len(), 2);
        assert_eq!(
            batch.events[0].dimension,
            UsageDimension::ObjectStorageReadRequest
        );
        assert_eq!(
            batch.events[1].dimension,
            UsageDimension::ObjectStorageEgressByte
        );
        assert_eq!(batch.events[1].quantity, 1_234.0);
        assert_eq!(batch.events[0].project_id, resolved().project_id);
    }

    #[test]
    fn a_request_with_no_response_body_does_not_invent_egress() {
        let directory = tempfile::tempdir().unwrap();
        let spool = MeteringSpool::open(directory.path(), SpoolLimits::default()).unwrap();

        StorageMeter::new(spool.clone())
            .begin(resolved(), Some(UsageDimension::ObjectStorageWriteRequest))
            .unwrap()
            .commit(0);

        let path = fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let batch: UsageBatch = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(batch.events.len(), 1);
    }

    #[test]
    fn a_free_operation_still_records_response_egress() {
        let directory = tempfile::tempdir().unwrap();
        let spool = MeteringSpool::open(directory.path(), SpoolLimits::default()).unwrap();

        StorageMeter::new(spool.clone())
            .begin(resolved(), None)
            .unwrap()
            .commit(321);

        let path = fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let batch: UsageBatch = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            batch.events[0].dimension,
            UsageDimension::ObjectStorageEgressByte
        );
        assert_eq!(batch.events[0].quantity, 321.0);
    }
}
