//! Reading cgroup v2, and the arithmetic that turns two readings into a bill.
//!
//! The parsing and the arithmetic are separated from the filesystem on purpose. This runs as a
//! DaemonSet on Linux and is developed on machines that have no `/sys/fs/cgroup` at all — but the
//! part where a bug costs somebody money is not the `read_to_string`, it is the subtraction. So the
//! subtraction is pure, takes its inputs as values, and is tested against fixtures that are
//! byte-for-byte what the kernel writes.
//!
//! ## What cgroup v2 actually gives you
//!
//! `cpu.stat` is a **cumulative** counter in microseconds since the cgroup was created:
//!
//! ```text
//! usage_usec 1234567
//! user_usec 1000000
//! system_usec 234567
//! ```
//!
//! `memory.current` is an **instantaneous** byte count:
//!
//! ```text
//! 536870912
//! ```
//!
//! Those are two different kinds of number and they are billed two different ways. CPU is a
//! difference between samples. Memory is an average over the interval — and the honest average from
//! point samples is the trapezoid, not the latest reading, because a pod that allocated a gigabyte
//! one millisecond before the sample did not hold it for the whole interval.

use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CgroupError {
    #[error("cpu.stat had no `usage_usec` line")]
    NoCpuUsage,

    #[error("`{0}` is not a number")]
    NotANumber(String),
}

/// One reading of one cgroup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Cumulative CPU time in microseconds, straight from `cpu.stat`.
    pub cpu_usec: u64,
    /// Bytes resident right now, from `memory.current`.
    pub memory_bytes: u64,
}

/// Parse `cpu.stat`.
///
/// Only `usage_usec` is required. The kernel adds fields between versions — `core_sched.force_idle_usec`
/// appeared in 5.19, throttling counters when a quota is set — and a parser that insisted on a fixed
/// set would break on a kernel upgrade, which is a thing that happens to a fleet without warning.
pub fn parse_cpu_stat(contents: &str) -> Result<u64, CgroupError> {
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("usage_usec ") {
            return value
                .trim()
                .parse()
                .map_err(|_| CgroupError::NotANumber(value.trim().to_owned()));
        }
    }
    Err(CgroupError::NoCpuUsage)
}

/// Parse `memory.current`.
///
/// A single integer, except at the root cgroup where it can read `max`. Treated as zero rather than
/// an error: the root is not a tenant, and refusing to parse it would fail a whole sweep over one
/// cgroup nobody is billed for.
pub fn parse_memory_current(contents: &str) -> Result<u64, CgroupError> {
    let trimmed = contents.trim();
    if trimmed == "max" {
        return Ok(0);
    }
    trimmed
        .parse()
        .map_err(|_| CgroupError::NotANumber(trimmed.to_owned()))
}

/// What one interval consumed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Consumption {
    /// vCPU-seconds: CPU time divided by wall time is utilisation, but the billed unit is the time
    /// itself, so this is just microseconds converted to seconds.
    pub vcpu_seconds: f64,
    /// GiB-seconds: the average bytes held, times the interval, in gibibytes.
    pub gib_seconds: f64,
}

/// The difference between two samples.
///
/// Returns `None` when the counter went backwards, which is not a hypothetical: a pod restarting
/// gets a fresh cgroup with a counter starting at zero, and a container recreated under the same
/// name looks identical from here. Subtracting would produce an enormous negative, and clamping it
/// to zero would silently lose the interval. `None` says "this pair is not comparable", and the
/// caller starts a new baseline.
///
/// **Billing the absolute value would be the expensive bug**: a restart would bill the pod's entire
/// lifetime CPU a second time.
pub fn consumption_between(
    previous: Sample,
    current: Sample,
    elapsed: Duration,
) -> Option<Consumption> {
    let cpu_delta = current.cpu_usec.checked_sub(previous.cpu_usec)?;

    // Trapezoid rule. The mean of two point samples is the best estimate of the average between
    // them, and using `current` alone would bill a spike that arrived at the last instant as though
    // it had been held for the whole interval.
    let mean_bytes = (previous.memory_bytes as f64 + current.memory_bytes as f64) / 2.0;

    const MICROS_PER_SECOND: f64 = 1_000_000.0;
    const BYTES_PER_GIB: f64 = 1_073_741_824.0;

    Some(Consumption {
        vcpu_seconds: cpu_delta as f64 / MICROS_PER_SECOND,
        gib_seconds: (mean_bytes / BYTES_PER_GIB) * elapsed.as_secs_f64(),
    })
}

/// Which tenant a cgroup belongs to.
///
/// TASK 24's actual requirement, and the reason this is a map rather than a field: **one VM hosts
/// several projects**. A sample that assumed one node is one tenant would attribute every pod on a
/// shared metal node to whichever project happened to be looked up first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribution {
    pub organization_id: uuid::Uuid,
    pub project_id: Option<uuid::Uuid>,
}

/// Read attribution out of the labels the kubelet writes into the pod's annotations.
///
/// Keyed on our own annotations rather than parsing the cgroup path. The path encodes a pod UID,
/// which would then need a lookup against the API server on every sample — a per-node, per-second
/// call to the control plane, which is the design that takes an API server down at scale.
pub fn attribution_from_labels(labels: &BTreeMap<String, String>) -> Option<Attribution> {
    let organization_id = labels
        .get("sproutos.dev/organization-id")
        .and_then(|value| uuid::Uuid::parse_str(value).ok())?;

    // A project is optional: a tenant's standalone backend service belongs to an organization and
    // to no project, and TASK 37 says that is a supported shape.
    let project_id = labels
        .get("sproutos.dev/project-id")
        .and_then(|value| uuid::Uuid::parse_str(value).ok());

    Some(Attribution {
        organization_id,
        project_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte what a 6.x kernel writes, extra fields included.
    const CPU_STAT: &str = "usage_usec 1234567\n\
                            user_usec 1000000\n\
                            system_usec 234567\n\
                            nr_periods 0\n\
                            nr_throttled 0\n\
                            throttled_usec 0\n\
                            nr_bursts 0\n\
                            burst_usec 0\n\
                            core_sched.force_idle_usec 0\n";

    #[test]
    fn cpu_stat_yields_usage_and_tolerates_unknown_fields() {
        assert_eq!(parse_cpu_stat(CPU_STAT), Ok(1_234_567));

        // A kernel upgrade adds fields. A parser that insisted on a fixed set would break a fleet.
        assert_eq!(parse_cpu_stat("something_new 1\nusage_usec 42\n"), Ok(42));
    }

    #[test]
    fn cpu_stat_without_usage_is_an_error_rather_than_zero() {
        // Zero would be indistinguishable from an idle pod, and would bill nothing forever.
        assert_eq!(
            parse_cpu_stat("user_usec 1\nsystem_usec 2\n"),
            Err(CgroupError::NoCpuUsage)
        );
    }

    #[test]
    fn memory_current_parses_and_the_root_reads_max() {
        assert_eq!(parse_memory_current("536870912\n"), Ok(536_870_912));
        // The root cgroup. Not a tenant, and not worth failing a sweep over.
        assert_eq!(parse_memory_current("max\n"), Ok(0));
        assert!(parse_memory_current("banana").is_err());
    }

    #[test]
    fn one_second_of_one_cpu_is_one_vcpu_second() {
        let consumption = consumption_between(
            Sample {
                cpu_usec: 0,
                memory_bytes: 0,
            },
            Sample {
                cpu_usec: 1_000_000,
                memory_bytes: 0,
            },
            Duration::from_secs(1),
        )
        .expect("comparable");

        assert!((consumption.vcpu_seconds - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn memory_is_averaged_across_the_interval_not_taken_from_the_last_reading() {
        const GIB: u64 = 1_073_741_824;

        /*
            Zero at the start, one gibibyte at the end, over ten seconds.

            The trapezoid says five GiB-seconds. Taking `current` alone would say ten — billing a
            pod that allocated a gigabyte just before the sample as though it had held it for the
            whole interval, which on a per-second sampler is a systematic overcharge on every
            workload with bursty memory.
        */
        let consumption = consumption_between(
            Sample {
                cpu_usec: 0,
                memory_bytes: 0,
            },
            Sample {
                cpu_usec: 0,
                memory_bytes: GIB,
            },
            Duration::from_secs(10),
        )
        .expect("comparable");

        assert!(
            (consumption.gib_seconds - 5.0).abs() < 1e-9,
            "{consumption:?}"
        );
    }

    #[test]
    fn a_counter_that_went_backwards_is_not_comparable() {
        /*
            A pod restarted. Its cgroup is new and its CPU counter starts at zero.

            Subtracting and taking the absolute value would bill the pod's entire previous lifetime
            a second time. Clamping to zero would silently drop the interval. Neither is acceptable
            for a number somebody pays, so this pair is refused and the caller re-baselines.
        */
        assert_eq!(
            consumption_between(
                Sample {
                    cpu_usec: 5_000_000,
                    memory_bytes: 0
                },
                Sample {
                    cpu_usec: 1_000,
                    memory_bytes: 0
                },
                Duration::from_secs(1),
            ),
            None
        );
    }

    #[test]
    fn an_unchanged_counter_bills_nothing_rather_than_being_refused() {
        // An idle pod is the common case, not an error. It must produce a zero, not a `None` that
        // the caller would treat as a restart.
        let consumption = consumption_between(
            Sample {
                cpu_usec: 7,
                memory_bytes: 0,
            },
            Sample {
                cpu_usec: 7,
                memory_bytes: 0,
            },
            Duration::from_secs(1),
        )
        .expect("comparable");
        assert_eq!(consumption.vcpu_seconds, 0.0);
    }

    #[test]
    fn attribution_needs_an_organization_and_tolerates_no_project() {
        let mut labels = BTreeMap::new();
        labels.insert(
            "sproutos.dev/organization-id".to_owned(),
            "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f".to_owned(),
        );

        // A standalone backend service belongs to an organization and to no project — TASK 37.
        let attribution = attribution_from_labels(&labels).expect("attributed");
        assert!(attribution.project_id.is_none());

        // Without an organization there is nobody to bill, so the sample is dropped rather than
        // attributed to a default.
        assert!(attribution_from_labels(&BTreeMap::new()).is_none());
    }

    #[test]
    fn a_malformed_organization_id_is_dropped_rather_than_guessed() {
        let mut labels = BTreeMap::new();
        labels.insert(
            "sproutos.dev/organization-id".to_owned(),
            "not-a-uuid".to_owned(),
        );
        assert!(attribution_from_labels(&labels).is_none());
    }
}
