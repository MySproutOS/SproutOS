//! Turning a token count into a billable event.
//!
//! The proxy owns billing for model usage, which is the point of routing model traffic through it
//! at all. Everything here is about one property: **a turn that spent tokens must produce an event,
//! including a turn nobody waited for.**
//!
//! ## Idempotency
//!
//! `external_id` is derived from the token id and the request's own identifier — never from a clock
//! or a random number — because ingest deduplicates on it and a retry after a timeout has to
//! produce the identical key. The metering README says this; it is repeated here because getting it
//! wrong looks like working code that occasionally bills twice.

use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};

use crate::session::Session;
use crate::usage::Usage;

/// What this emitter calls itself in the batch, for attribution in the ledger.
pub const SOURCE: &str = "llm-proxy";

#[derive(Debug, thiserror::Error)]
pub enum MeterError {
    #[error("the organization id on the session is not a uuid: {0}")]
    BadOrganization(String),
    #[error("the project id on the session is not a uuid: {0}")]
    BadProject(String),
}

/// Build the batch for one completed (or abandoned) turn.
///
/// Returns `None` when nothing was observed. An empty batch is not the same as a free turn — it
/// means this proxy saw no usage at all, which is what happens when a request fails before the
/// model runs, and emitting a zero-quantity event for it would put noise in every customer's
/// ledger.
pub fn batch_for(
    session: &Session,
    request_id: &str,
    usage: Usage,
    occurred_at_ms: i64,
) -> Result<Option<UsageBatch>, MeterError> {
    if usage.is_empty() {
        return Ok(None);
    }

    let organization_id = session
        .organization_id
        .parse()
        .map_err(|_| MeterError::BadOrganization(session.organization_id.clone()))?;

    let project_id = match session.project_id.as_deref() {
        None => None,
        Some(raw) => Some(
            raw.parse()
                .map_err(|_| MeterError::BadProject(raw.to_string()))?,
        ),
    };

    let mut events = Vec::with_capacity(3);
    for (dimension, quantity) in [
        (UsageDimension::AiInputToken, usage.input_tokens),
        (UsageDimension::AiOutputToken, usage.output_tokens),
        (UsageDimension::AiCacheReadToken, usage.cache_read_tokens),
    ] {
        if quantity == 0 {
            continue;
        }
        /*
          The dimension is part of the key.

          Three events share one request, and without the dimension in the key ingest would
          deduplicate them into whichever arrived first — so a turn would be billed for its input
          and never its output, which is the cheaper mistake and therefore the one that survives
          unnoticed.
        */
        let external_id = format!("{SOURCE}:{}:{request_id}:{dimension:?}", session.token_id);
        let mut event = UsageEvent::new(
            external_id,
            organization_id,
            dimension,
            quantity as f64,
            occurred_at_ms,
        );
        event.project_id = project_id;
        event
            .attributes
            .insert("upstream".into(), format!("{:?}", session.upstream));
        events.push(event);
    }

    Ok(Some(UsageBatch::new(SOURCE, events)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Upstream;

    fn session() -> Session {
        Session {
            token_id: "01a03e5d-8cbf-7415-9ac6-82c3476aeb5c".into(),
            organization_id: "01a03b00-0000-7000-8000-00000000beef".into(),
            project_id: Some("01a03b96-a3d3-71f5-9f1d-af7569938433".into()),
            upstream: Upstream::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            secret: "sk-secret".into(),
        }
    }

    #[test]
    fn one_event_per_non_zero_dimension() {
        let batch = batch_for(
            &session(),
            "req_1",
            Usage {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 0,
            },
            1_700_000_000_000,
        )
        .unwrap()
        .unwrap();

        // The cache dimension is absent rather than zero: a zero-quantity event is noise in a
        // ledger somebody reads.
        assert_eq!(batch.events.len(), 2);
        batch.validate().expect("the batch should be valid");
    }

    #[test]
    fn the_key_distinguishes_the_dimensions() {
        let batch = batch_for(
            &session(),
            "req_1",
            Usage {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_tokens: 5,
            },
            1,
        )
        .unwrap()
        .unwrap();

        let keys: std::collections::BTreeSet<_> =
            batch.events.iter().map(|e| e.external_id.clone()).collect();
        // Without the dimension in the key, ingest deduplicates three events into one and the turn
        // is billed for input and never output — the cheaper mistake, so the one that survives.
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn the_key_is_stable_across_retries() {
        let usage = Usage {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_tokens: 0,
        };
        // Two builds of the same turn, at different times. Ingest deduplicates on this key, so a
        // retry after a timeout must produce the identical one — which rules out a clock read or a
        // random number, and is why `occurred_at` is an input rather than `now()`.
        let first = batch_for(&session(), "req_1", usage, 1).unwrap().unwrap();
        let second = batch_for(&session(), "req_1", usage, 999).unwrap().unwrap();
        assert_eq!(first.events[0].external_id, second.events[0].external_id);
    }

    #[test]
    fn nothing_observed_is_no_batch_rather_than_an_empty_one() {
        assert!(
            batch_for(&session(), "req_1", Usage::default(), 1)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn an_abandoned_turn_still_bills_what_was_seen() {
        // Only the input count arrived before the client hung up. Billing nothing here is a hole
        // that is reachable by accident and then on purpose.
        let batch = batch_for(
            &session(),
            "req_1",
            Usage {
                input_tokens: 900,
                output_tokens: 0,
                cache_read_tokens: 0,
            },
            1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].quantity, 900.0);
    }

    #[test]
    fn a_malformed_organization_is_an_error_not_a_dropped_bill() {
        let mut broken = session();
        broken.organization_id = "not-a-uuid".into();
        // Swallowing this would silently stop billing an organization whose id was mangled
        // somewhere upstream. It is loud instead.
        assert!(matches!(
            batch_for(
                &broken,
                "req_1",
                Usage {
                    input_tokens: 1,
                    output_tokens: 0,
                    cache_read_tokens: 0
                },
                1
            ),
            Err(MeterError::BadOrganization(_))
        ));
    }
}
