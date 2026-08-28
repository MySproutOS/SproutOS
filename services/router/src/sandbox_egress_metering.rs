//! Durable AWS internet-data-transfer usage observed by the Daytona forward proxy.

use sproutos_llm_proxy::spool::{MeteringSpool, SpoolReservation};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use sproutos_sandbox_forward_proxy::{
    EgressMeter, EgressObservation, EgressReservation, MeteringCapacityError,
};

const SOURCE: &str = "sandbox-forward-proxy";

#[derive(Debug, Clone)]
pub struct SandboxEgressMeter {
    spool: MeteringSpool,
}

impl SandboxEgressMeter {
    pub fn new(spool: MeteringSpool) -> Self {
        Self { spool }
    }
}

impl EgressMeter for SandboxEgressMeter {
    fn reserve(&self) -> Result<Box<dyn EgressReservation>, MeteringCapacityError> {
        self.spool
            .reserve()
            .map(|reservation| {
                Box::new(DurableReservation(reservation)) as Box<dyn EgressReservation>
            })
            .map_err(|cause| {
                tracing::error!(%cause, source = SOURCE, "sandbox egress metering spool has no capacity");
                MeteringCapacityError
            })
    }
}

struct DurableReservation(SpoolReservation);

impl EgressReservation for DurableReservation {
    fn commit(self: Box<Self>, observation: EgressObservation) {
        let Some(batch) = egress_batch(&observation) else {
            return;
        };
        if let Err(cause) = self.0.commit(&batch) {
            tracing::error!(
                %cause,
                sandbox_id = %observation.authorization.sandbox_id,
                "sandbox egress usage could not be committed to the durable spool"
            );
        }
    }
}

fn egress_batch(observation: &EgressObservation) -> Option<UsageBatch> {
    let bytes = observation.total_bytes();
    if bytes == 0 {
        return None;
    }
    let event = UsageEvent::new(
        format!(
            "{SOURCE}:{}:sandbox_egress_byte:{}",
            observation.authorization.sandbox_id, observation.connection_id
        ),
        observation.authorization.organization_id,
        UsageDimension::SandboxEgressByte,
        bytes as f64,
        observation.occurred_at,
    )
    .with_project(observation.authorization.project_id)
    .with_attribute("protocol", observation.protocol)
    .with_attribute("request_bytes", observation.request_bytes.to_string())
    .with_attribute("response_bytes", observation.response_bytes.to_string())
    .with_attribute(
        "sandbox_id",
        observation.authorization.sandbox_id.to_string(),
    );
    Some(UsageBatch::new(SOURCE, vec![event]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sproutos_sandbox_forward_proxy::{SandboxAuthorization, SandboxState};
    use uuid::Uuid;

    #[test]
    fn attributes_total_aws_dto_to_the_authorized_org_and_project() {
        let sandbox_id = Uuid::now_v7();
        let organization_id = Uuid::now_v7();
        let project_id = Uuid::now_v7();
        let connection_id = Uuid::now_v7();
        let batch = egress_batch(&EgressObservation {
            authorization: SandboxAuthorization {
                sandbox_id,
                organization_id,
                project_id,
                state: SandboxState::Running,
            },
            connection_id,
            request_bytes: 17,
            response_bytes: 29,
            occurred_at: 1_723_459_200_000,
            protocol: "connect",
        })
        .unwrap();

        assert_eq!(batch.source, SOURCE);
        assert_eq!(batch.events.len(), 1);
        let event = &batch.events[0];
        assert_eq!(event.organization_id, organization_id);
        assert_eq!(event.project_id, Some(project_id));
        assert_eq!(event.dimension, UsageDimension::SandboxEgressByte);
        assert_eq!(event.quantity, 46.0);
        assert_eq!(event.occurred_at, 1_723_459_200_000);
        assert_eq!(event.attributes["sandbox_id"], sandbox_id.to_string());
        assert_eq!(event.attributes["request_bytes"], "17");
        assert_eq!(event.attributes["response_bytes"], "29");
        assert_eq!(
            event.external_id,
            format!("{SOURCE}:{sandbox_id}:sandbox_egress_byte:{connection_id}")
        );
    }
}
