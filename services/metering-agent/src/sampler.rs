//! Turning a stream of readings into events somebody can be charged for.
//!
//! The dangerous operations in a metering agent are not the reads. They are:
//!
//! - **Re-baselining.** A pod restarts, its counter resets, and the naive difference is enormous.
//! - **Double counting.** A batch is sent, the response is lost, the batch is retried, and the
//!   tenant pays twice. The ingest route dedupes on `external_id`, which only works if a retry
//!   reuses the same one.
//! - **Silent loss.** An event that cannot be sent is dropped and nobody notices, because the only
//!   evidence it existed was in this process's memory.
//!
//! This module is where all three live, and it is pure: readings in, events out, no clock and no
//! network. That is what makes them testable on a machine with no cgroups.

use std::collections::BTreeMap;
use std::time::Duration;

use sproutos_metering_proto::{UsageDimension, UsageEvent};

use crate::cgroup::{Attribution, Consumption, Sample, consumption_between};

/// A cgroup being watched, and what it read last time.
#[derive(Debug, Clone)]
pub struct Watched {
    pub attribution: Attribution,
    pub last: Sample,
}

/// What one sweep produced.
#[derive(Debug, Default)]
pub struct SweepResult {
    pub events: Vec<UsageEvent>,
    /// Cgroups whose counter went backwards. Counted rather than logged per occurrence: a rolling
    /// deploy restarts every pod at once, and a line each would bury the sweep that matters.
    pub rebaselined: usize,
}

/// Compare a sweep's readings against the previous ones and emit what was consumed.
///
/// `now_millis` is a parameter rather than a call to the clock, so a test can pin it. An event's
/// `occurred_at` is part of its identity, and a function that read the clock internally could not be
/// asserted against a fixed expectation.
pub fn sweep(
    watched: &mut BTreeMap<String, Watched>,
    readings: &BTreeMap<String, (Attribution, Sample)>,
    elapsed: Duration,
    now_millis: i64,
    node: &str,
) -> SweepResult {
    let mut result = SweepResult::default();

    for (cgroup, (attribution, current)) in readings {
        let Some(previous) = watched.get(cgroup) else {
            /*
                First sighting: record and bill nothing.

                A cgroup's counter is cumulative from its creation, so treating a first reading as a
                delta would bill everything the pod did before this agent started — including
                everything it did under a *previous* agent that already billed it.
            */
            watched.insert(
                cgroup.clone(),
                Watched {
                    attribution: attribution.clone(),
                    last: *current,
                },
            );
            continue;
        };

        match consumption_between(previous.last, *current, elapsed) {
            Some(consumption) => {
                result.events.extend(events_for(
                    cgroup,
                    attribution,
                    consumption,
                    now_millis,
                    node,
                ));
            }
            None => {
                // The counter went backwards: a restart. Re-baseline and bill nothing for the gap,
                // which loses at most one interval rather than billing a lifetime twice.
                result.rebaselined += 1;
            }
        }

        watched.insert(
            cgroup.clone(),
            Watched {
                attribution: attribution.clone(),
                last: *current,
            },
        );
    }

    /*
        Forget cgroups that disappeared.

        Without this the map grows for the life of the process — one entry per pod ever scheduled on
        a node that runs thousands. It also matters for correctness: a cgroup name can be reused, and
        a stale baseline under a reused name is a counter that appears to have gone backwards.
    */
    watched.retain(|cgroup, _| readings.contains_key(cgroup));

    result
}

/// One consumption becomes two events, because CPU and memory are billed separately.
fn events_for(
    cgroup: &str,
    attribution: &Attribution,
    consumption: Consumption,
    now_millis: i64,
    node: &str,
) -> Vec<UsageEvent> {
    let mut events = Vec::new();

    for (dimension, quantity) in [
        (UsageDimension::SiteVcpuSecond, consumption.vcpu_seconds),
        (UsageDimension::SiteGibSecond, consumption.gib_seconds),
    ] {
        // An idle pod produces a zero every second on every node. Sending them would be the bulk of
        // the traffic and would rate nothing.
        if quantity <= 0.0 {
            continue;
        }

        let mut event = UsageEvent::new(
            external_id(cgroup, dimension, now_millis),
            attribution.organization_id,
            dimension,
            quantity,
            now_millis,
        );
        if let Some(project_id) = attribution.project_id {
            event = event.with_project(project_id);
        }
        events.push(event.with_attribute("node", node));
    }

    events
}

/// The idempotency key the ingest route dedupes on.
///
/// Deterministic from the cgroup, the dimension and the sample's timestamp — **not** random, and
/// not a counter. A retry after a lost response must produce the same id, or the tenant pays twice
/// for the interval whose acknowledgement went missing. That is the single most expensive bug this
/// agent can have, and it is invisible in testing because it only happens when a response is lost.
pub fn external_id(cgroup: &str, dimension: UsageDimension, occurred_at: i64) -> String {
    format!("{cgroup}:{}:{occurred_at}", dimension.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const GIB: u64 = 1_073_741_824;

    fn attribution() -> Attribution {
        Attribution {
            organization_id: Uuid::parse_str("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f").unwrap(),
            project_id: Some(Uuid::parse_str("01912d40-0000-7000-8000-0000000000a1").unwrap()),
        }
    }

    fn readings(cpu_usec: u64, memory_bytes: u64) -> BTreeMap<String, (Attribution, Sample)> {
        BTreeMap::from([(
            "pod-a".to_owned(),
            (
                attribution(),
                Sample {
                    cpu_usec,
                    memory_bytes,
                },
            ),
        )])
    }

    #[test]
    fn the_first_sighting_bills_nothing() {
        let mut watched = BTreeMap::new();
        let result = sweep(
            &mut watched,
            &readings(5_000_000, GIB),
            Duration::from_secs(1),
            1_000,
            "node-1",
        );

        /*
            A cgroup's counter is cumulative from creation. Billing the first reading as a delta
            charges for everything the pod did before this agent started — which a previous agent
            already billed.
        */
        assert!(result.events.is_empty());
        assert_eq!(watched.len(), 1);
    }

    #[test]
    fn the_second_sighting_bills_the_difference() {
        let mut watched = BTreeMap::new();
        sweep(
            &mut watched,
            &readings(0, GIB),
            Duration::from_secs(1),
            1_000,
            "node-1",
        );
        let result = sweep(
            &mut watched,
            &readings(2_000_000, GIB),
            Duration::from_secs(1),
            2_000,
            "node-1",
        );

        let cpu = result
            .events
            .iter()
            .find(|event| event.dimension == UsageDimension::SiteVcpuSecond)
            .expect("a cpu event");
        assert!((cpu.quantity - 2.0).abs() < 1e-9);
        assert_eq!(cpu.project_id, attribution().project_id);
    }

    #[test]
    fn a_restart_rebaselines_instead_of_billing_a_lifetime() {
        let mut watched = BTreeMap::new();
        sweep(
            &mut watched,
            &readings(9_000_000, GIB),
            Duration::from_secs(1),
            1_000,
            "node-1",
        );

        // The pod restarted: fresh cgroup, counter back to nearly zero.
        let result = sweep(
            &mut watched,
            &readings(1_000, GIB),
            Duration::from_secs(1),
            2_000,
            "node-1",
        );

        assert_eq!(result.rebaselined, 1);
        assert!(
            result.events.is_empty(),
            "a restart must not produce a charge"
        );

        // And the next interval bills from the new baseline rather than from the old one.
        let next = sweep(
            &mut watched,
            &readings(1_001_000, GIB),
            Duration::from_secs(1),
            3_000,
            "node-1",
        );
        let cpu = next
            .events
            .iter()
            .find(|event| event.dimension == UsageDimension::SiteVcpuSecond)
            .expect("a cpu event");
        assert!((cpu.quantity - 1.0).abs() < 1e-9, "{}", cpu.quantity);
    }

    #[test]
    fn a_retry_of_the_same_interval_carries_the_same_idempotency_key() {
        /*
            The most expensive bug this agent can have, and the one that only appears in production.

            A batch is sent, the response is lost, the agent retries. The ingest route dedupes on
            `external_id`, so a random or counter-based id means the tenant is charged twice for the
            interval whose acknowledgement went missing.
        */
        let first = external_id("pod-a", UsageDimension::SiteVcpuSecond, 1_700_000_000_000);
        let again = external_id("pod-a", UsageDimension::SiteVcpuSecond, 1_700_000_000_000);
        assert_eq!(first, again);

        // And two different intervals, or two dimensions of one interval, are distinct.
        assert_ne!(
            first,
            external_id("pod-a", UsageDimension::SiteVcpuSecond, 1_700_000_001_000)
        );
        assert_ne!(
            first,
            external_id("pod-a", UsageDimension::SiteGibSecond, 1_700_000_000_000)
        );
    }

    #[test]
    fn an_idle_pod_produces_no_events() {
        let mut watched = BTreeMap::new();
        sweep(
            &mut watched,
            &readings(7, 0),
            Duration::from_secs(1),
            1_000,
            "node-1",
        );
        let result = sweep(
            &mut watched,
            &readings(7, 0),
            Duration::from_secs(1),
            2_000,
            "node-1",
        );

        // Every idle pod on every node, every second, would otherwise be the bulk of the traffic —
        // and every one of them would rate to nothing.
        assert!(result.events.is_empty());
    }

    #[test]
    fn a_cgroup_that_disappeared_is_forgotten() {
        let mut watched = BTreeMap::new();
        sweep(
            &mut watched,
            &readings(1, GIB),
            Duration::from_secs(1),
            1_000,
            "node-1",
        );
        assert_eq!(watched.len(), 1);

        // The pod is gone. Keeping its baseline grows the map for the life of the process, and a
        // reused cgroup name would then look like a counter that went backwards.
        sweep(
            &mut watched,
            &BTreeMap::new(),
            Duration::from_secs(1),
            2_000,
            "node-1",
        );
        assert!(watched.is_empty());
    }

    #[test]
    fn several_projects_on_one_node_are_billed_separately() {
        /*
            TASK 24's actual requirement. A sampler that assumed one node is one tenant would
            attribute every pod on a shared metal node to whichever project it looked up first —
            which on the densest nodes is the most wrong it could possibly be.
        */
        let other = Attribution {
            organization_id: Uuid::parse_str("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e70").unwrap(),
            project_id: Some(Uuid::parse_str("01912d40-0000-7000-8000-0000000000b2").unwrap()),
        };

        let mut watched = BTreeMap::new();
        let first = BTreeMap::from([
            (
                "pod-a".to_owned(),
                (
                    attribution(),
                    Sample {
                        cpu_usec: 0,
                        memory_bytes: 0,
                    },
                ),
            ),
            (
                "pod-b".to_owned(),
                (
                    other.clone(),
                    Sample {
                        cpu_usec: 0,
                        memory_bytes: 0,
                    },
                ),
            ),
        ]);
        sweep(
            &mut watched,
            &first,
            Duration::from_secs(1),
            1_000,
            "node-1",
        );

        let second = BTreeMap::from([
            (
                "pod-a".to_owned(),
                (
                    attribution(),
                    Sample {
                        cpu_usec: 1_000_000,
                        memory_bytes: 0,
                    },
                ),
            ),
            (
                "pod-b".to_owned(),
                (
                    other.clone(),
                    Sample {
                        cpu_usec: 3_000_000,
                        memory_bytes: 0,
                    },
                ),
            ),
        ]);
        let result = sweep(
            &mut watched,
            &second,
            Duration::from_secs(1),
            2_000,
            "node-1",
        );

        let a = result
            .events
            .iter()
            .find(|event| event.project_id == attribution().project_id)
            .expect("pod-a billed");
        let b = result
            .events
            .iter()
            .find(|event| event.project_id == other.project_id)
            .expect("pod-b billed");

        assert!((a.quantity - 1.0).abs() < 1e-9);
        assert!((b.quantity - 3.0).abs() < 1e-9);
        assert_ne!(a.organization_id, b.organization_id);
    }
}
