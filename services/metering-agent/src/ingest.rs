//! Getting a batch to the control plane, or keeping it until we can.
//!
//! The interesting behaviour here is what happens when the POST fails, because that is the ordinary
//! case on a fleet: a rolling deploy of the API, a network blip, a pod eviction. An agent that
//! dropped a failed batch would lose revenue silently — the only record those events ever had was
//! in this process.
//!
//! So failed batches are held and retried, and the retry reuses the same `external_id`s, which is
//! what makes it safe: the ingest route dedupes on them, so a batch delivered twice is charged
//! once.

use sproutos_metering_proto::{UsageBatch, UsageEvent, sign};

/// How many events to hold when the control plane is unreachable.
///
/// Bounded, and dropping the **oldest** when it fills. An unbounded queue on a node under memory
/// pressure is an OOM kill, which loses everything rather than the oldest slice — and the oldest
/// events are the ones most likely to have been superseded by a re-baseline anyway.
///
/// At two events per pod per interval, this is roughly an hour of a busy node.
pub const MAX_PENDING: usize = 10_000;

/// Events waiting to be delivered.
#[derive(Debug, Default)]
pub struct Pending {
    events: Vec<UsageEvent>,
    /// How many were dropped because the buffer filled. Reported, never silent: a metering agent
    /// that loses events without saying so is worse than one that crashes.
    pub dropped: u64,
}

impl Pending {
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Add events, dropping the oldest if that would exceed the cap.
    pub fn extend(&mut self, events: Vec<UsageEvent>) {
        self.events.extend(events);

        if self.events.len() > MAX_PENDING {
            let excess = self.events.len() - MAX_PENDING;
            self.events.drain(..excess);
            self.dropped += excess as u64;
        }
    }

    /// Take everything for a delivery attempt.
    ///
    /// Taken rather than borrowed, so a failed attempt has to explicitly give them back. Borrowing
    /// would make "forgot to clear on success" and "forgot to restore on failure" the same shape of
    /// mistake, and one of them double-bills.
    pub fn take(&mut self) -> Vec<UsageEvent> {
        std::mem::take(&mut self.events)
    }

    /// Give a failed attempt's events back, ahead of anything gathered since.
    pub fn restore(&mut self, events: Vec<UsageEvent>) {
        let mut restored = events;
        restored.append(&mut self.events);
        self.events = restored;

        if self.events.len() > MAX_PENDING {
            let excess = self.events.len() - MAX_PENDING;
            self.events.drain(..excess);
            self.dropped += excess as u64;
        }
    }
}

/// Build and sign the batch the ingest route expects.
///
/// The HMAC is over the canonical form from `metering-proto`, which both sides compute
/// independently — a divergence there is a batch the API rejects as forged.
pub fn prepare(source: &str, events: Vec<UsageEvent>, key: &[u8]) -> (UsageBatch, String) {
    let batch = UsageBatch::new(source, events);
    let signature = sign(&batch, key);
    (batch, signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sproutos_metering_proto::{UsageDimension, verify};
    use uuid::Uuid;

    fn event(index: usize) -> UsageEvent {
        UsageEvent::new(
            format!("event-{index}"),
            Uuid::parse_str("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f").unwrap(),
            UsageDimension::SiteVcpuSecond,
            1.0,
            1_700_000_000_000 + index as i64,
        )
    }

    #[test]
    fn a_failed_delivery_keeps_its_events() {
        let mut pending = Pending::default();
        pending.extend(vec![event(1), event(2)]);

        let taken = pending.take();
        assert_eq!(taken.len(), 2);
        assert!(pending.is_empty());

        // The POST failed. The only record these events ever had was in this process.
        pending.restore(taken);
        assert_eq!(pending.len(), 2);
    }

    #[test]
    fn restored_events_stay_ahead_of_newer_ones() {
        let mut pending = Pending::default();
        let taken = {
            pending.extend(vec![event(1)]);
            pending.take()
        };
        pending.extend(vec![event(2)]);
        pending.restore(taken);

        // Oldest first, so a buffer that fills drops the oldest rather than the newest — and so the
        // batch the API sees is in the order the intervals happened.
        let all = pending.take();
        assert_eq!(all[0].external_id, "event-1");
        assert_eq!(all[1].external_id, "event-2");
    }

    #[test]
    fn a_full_buffer_drops_the_oldest_and_counts_it() {
        let mut pending = Pending::default();
        pending.extend((0..MAX_PENDING + 5).map(event).collect());

        assert_eq!(pending.len(), MAX_PENDING);
        assert_eq!(pending.dropped, 5);

        // The oldest went, not the newest: a re-baseline may already have superseded them, and the
        // recent intervals are the ones still worth money.
        let all = pending.take();
        assert_eq!(all[0].external_id, "event-5");
    }

    #[test]
    fn a_prepared_batch_verifies_with_the_shared_key() {
        // The API recomputes this from `metering-proto`'s canonical form. A divergence is a batch
        // rejected as forged, which is the same outcome as losing it.
        let key = b"a shared secret";
        let (batch, signature) = prepare("node-1", vec![event(1)], key);
        assert!(verify(&batch, key, &signature));
        assert!(!verify(&batch, b"the wrong key", &signature));
    }
}
