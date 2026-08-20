//! The Linux half: finding cgroups and reading them.
//!
//! Separated from `cgroup.rs` and `sampler.rs` so those stay pure and testable anywhere. This file
//! is the part that only works on a node, and it is deliberately thin — it finds paths and reads
//! files, and every decision worth testing has already been made somewhere else.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::cgroup::{
    Attribution, Sample, attribution_from_labels, parse_cpu_stat, parse_memory_current,
};

/// Where the kubelet mounts the unified hierarchy inside a privileged pod.
///
/// The host's `/sys/fs/cgroup` bind-mounted in. cgroup **v2** specifically — v1 has a directory per
/// controller and no `cpu.stat` in this shape, so a node still on v1 produces no readings rather
/// than wrong ones. `kata-deploy` requires v2 anyway, which is what makes that acceptable.
pub const DEFAULT_ROOT: &str = "/sys/fs/cgroup";

/// One cgroup found on the node, with whatever we could learn about who owns it.
pub struct Found {
    pub name: String,
    pub attribution: Attribution,
    pub sample: Sample,
}

/// Read every pod cgroup under `root` that carries a SproutOS attribution.
///
/// Returns what it could read rather than failing the sweep. A cgroup can vanish between the
/// directory listing and the read — a pod exiting mid-sweep is ordinary, not exceptional — and a
/// sweep that aborted on the first `ENOENT` would lose every other pod on the node.
pub fn read_all(root: &Path, labels: &BTreeMap<String, BTreeMap<String, String>>) -> Vec<Found> {
    let mut found = Vec::new();

    for (name, pod_labels) in labels {
        let Some(attribution) = attribution_from_labels(pod_labels) else {
            // No organization: nobody to bill. Not an error — plenty of cgroups on a node belong to
            // the platform rather than to a tenant.
            continue;
        };

        let Some(sample) = read_one(&root.join(name)) else {
            continue;
        };

        found.push(Found {
            name: name.clone(),
            attribution,
            sample,
        });
    }

    found
}

/// Read one cgroup's two files.
///
/// `None` when either is missing or malformed. Both are needed: an event with CPU and no memory
/// would bill half an interval, which is worse than billing none of it — the missing half is
/// invisible, and the tenant is undercharged silently rather than obviously.
pub fn read_one(directory: &Path) -> Option<Sample> {
    let cpu = std::fs::read_to_string(directory.join("cpu.stat")).ok()?;
    let memory = std::fs::read_to_string(directory.join("memory.current")).ok()?;

    Some(Sample {
        cpu_usec: parse_cpu_stat(&cpu).ok()?,
        memory_bytes: parse_memory_current(&memory).ok()?,
    })
}

/// The node this agent is running on, from the downward API.
///
/// Required rather than defaulted: every event carries it as an attribute, and a fleet where half
/// the events say `unknown` cannot answer "which node is overcharging".
pub fn node_name() -> Option<String> {
    std::env::var("NODE_NAME")
        .ok()
        .filter(|name| !name.is_empty())
}

/// Where to look, overridable for tests and for a node that mounts it elsewhere.
pub fn root() -> PathBuf {
    PathBuf::from(std::env::var("CGROUP_ROOT").unwrap_or_else(|_| DEFAULT_ROOT.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A fake cgroup tree, which is all `read_one` needs — the files are plain text.
    ///
    /// This is why the reads live in their own module: a temporary directory is indistinguishable
    /// from `/sys/fs/cgroup` to `read_to_string`, so the one piece of this file worth testing is
    /// testable on any platform.
    fn tree() -> PathBuf {
        let base = std::env::temp_dir().join(format!("metering-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(base.join("pod-a")).expect("mkdir");
        fs::write(
            base.join("pod-a/cpu.stat"),
            "usage_usec 1234567\nuser_usec 1000000\n",
        )
        .expect("write");
        fs::write(base.join("pod-a/memory.current"), "536870912\n").expect("write");
        base
    }

    #[test]
    fn a_complete_cgroup_reads() {
        let base = tree();
        let sample = read_one(&base.join("pod-a")).expect("readable");
        assert_eq!(sample.cpu_usec, 1_234_567);
        assert_eq!(sample.memory_bytes, 536_870_912);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_half_readable_cgroup_yields_nothing() {
        let base = tree();
        fs::remove_file(base.join("pod-a/memory.current")).expect("rm");

        /*
            CPU without memory would bill half the interval — and the missing half is invisible, so
            the tenant is quietly undercharged rather than obviously. Refusing the sample loses one
            interval and says so in the sweep's counters.
        */
        assert!(read_one(&base.join("pod-a")).is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_cgroup_that_vanished_yields_nothing_rather_than_panicking() {
        // A pod exiting mid-sweep is ordinary. Aborting here would lose every other pod on the node.
        assert!(read_one(Path::new("/definitely/not/a/cgroup")).is_none());
    }

    #[test]
    fn a_cgroup_without_an_organization_is_skipped() {
        let base = tree();
        let labels = BTreeMap::from([("pod-a".to_owned(), BTreeMap::new())]);

        // Plenty of cgroups on a node belong to the platform. Nobody to bill is not an error.
        assert!(read_all(&base, &labels).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_attributed_cgroup_is_returned() {
        let base = tree();
        let labels = BTreeMap::from([(
            "pod-a".to_owned(),
            BTreeMap::from([(
                "sproutos.dev/organization-id".to_owned(),
                "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f".to_owned(),
            )]),
        )]);

        let found = read_all(&base, &labels);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sample.cpu_usec, 1_234_567);
        let _ = fs::remove_dir_all(&base);
    }
}
