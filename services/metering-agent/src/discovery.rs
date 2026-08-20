//! Which cgroup on this node belongs to which tenant.
//!
//! The agent samples cgroups; the cgroups are named after pod UIDs; and nothing in a cgroup says
//! who is paying. This module is the join.
//!
//! **Why a list against the API server rather than the kubelet's pod-resources socket.** The socket
//! is the lower-privilege source and was the original intent, but it reports devices and containers
//! rather than pod labels — the attribution SproutOS bills on lives in the pod's own labels, so the
//! socket would still need a second lookup to be useful. One list per node per refresh interval,
//! filtered to this node, is a request every thirty seconds from each node; the design this replaces
//! would have been one per node *per second*, which is the shape that takes an API server down.
//!
//! The path construction is the part that had to be observed rather than assumed, and it was — on a
//! GKE Container-Optimized node, cgroup v2, systemd driver.

use std::collections::BTreeMap;

use serde::Deserialize;

/// How often to refresh the node's pod list.
///
/// Longer than the sample interval and shorter than the flush interval on purpose: a pod that
/// appears between refreshes is sampled from the next one, losing at most this much of its first
/// half-minute, and a pod that vanishes stops being sampled when its cgroup does.
pub const REFRESH_INTERVAL_SECS: u64 = 30;

const SERVICE_ACCOUNT: &str = "/var/run/secrets/kubernetes.io/serviceaccount";

#[derive(Debug, Deserialize)]
struct PodList {
    items: Vec<Pod>,
}

#[derive(Debug, Deserialize)]
struct Pod {
    metadata: Metadata,
    #[serde(default)]
    status: Status,
}

#[derive(Debug, Deserialize)]
struct Metadata {
    uid: Option<String>,
    #[serde(default)]
    labels: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
struct Status {
    #[serde(rename = "qosClass")]
    qos_class: Option<String>,
}

/// The cgroup path for one pod, relative to the cgroup root.
///
/// systemd's escaping, which is not optional: the kubelet writes the pod UID with **underscores**
/// where the UID has hyphens, because a hyphen in a systemd unit name is a path separator. Getting
/// this wrong produces a path that does not exist, and the agent then bills nothing while looking
/// like it is working — which is exactly the failure this whole module exists to end.
///
/// Guaranteed pods have no QoS level in their path; burstable and best-effort do. That asymmetry is
/// in the kubelet, not a simplification here.
pub fn cgroup_path(uid: &str, qos_class: &str) -> Option<String> {
    let escaped = uid.replace('-', "_");

    match qos_class.to_ascii_lowercase().as_str() {
        "guaranteed" => Some(format!("kubepods.slice/kubepods-pod{escaped}.slice")),
        "burstable" => Some(format!(
            "kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod{escaped}.slice"
        )),
        "besteffort" => Some(format!(
            "kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod{escaped}.slice"
        )),
        // An unrecognised class is not a guess worth making. A wrong path reads as an absent pod,
        // and an absent pod is silently unbilled.
        _ => None,
    }
}

/// Turn an API server pod list into the map the sampler wants: cgroup path -> that pod's labels.
///
/// Pods with no SproutOS labels are kept rather than filtered here — `attribution_from_labels`
/// decides who is billable, and doing it in one place means the rule cannot drift between them.
pub fn paths_from_pod_list(body: &str) -> BTreeMap<String, BTreeMap<String, String>> {
    let Ok(list) = serde_json::from_str::<PodList>(body) else {
        return BTreeMap::new();
    };

    let mut out = BTreeMap::new();

    for pod in list.items {
        let (Some(uid), Some(qos)) = (pod.metadata.uid, pod.status.qos_class) else {
            continue;
        };
        let Some(path) = cgroup_path(&uid, &qos) else {
            continue;
        };

        out.insert(path, pod.metadata.labels);
    }

    out
}

/// Reads the projected service-account token on every call.
///
/// The kubelet rotates that file in place, so a token read once is a credential that starts
/// returning 401 after roughly an hour — and a metering agent that silently stops being able to
/// attribute anything is a metering agent that silently stops billing.
pub fn token() -> std::io::Result<String> {
    Ok(std::fs::read_to_string(format!("{SERVICE_ACCOUNT}/token"))?
        .trim()
        .to_owned())
}

/// An HTTP client that trusts the cluster's own CA.
///
/// The API server presents a certificate signed by the *cluster's* CA, not a public one. A client
/// built with only the public roots — which is what a `scratch` image's `ca-certificates.crt`
/// provides — fails the handshake on every request, and the agent then attributes nothing while
/// looking perfectly healthy: pods Running, cgroups sampled, invoices empty.
///
/// The CA is projected into the pod alongside the token, so this needs no extra mount.
pub fn api_client() -> anyhow::Result<reqwest::Client> {
    let pem = std::fs::read(format!("{SERVICE_ACCOUNT}/ca.crt"))?;

    Ok(reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&pem)?)
        // Shorter than the refresh interval: a hung API server must not stall the sampling loop,
        // and the previous pod list stays usable while it is unreachable.
        .timeout(std::time::Duration::from_secs(10))
        .build()?)
}

pub fn api_server() -> Option<String> {
    let host = std::env::var("KUBERNETES_SERVICE_HOST").ok()?;
    let port = std::env::var("KUBERNETES_SERVICE_PORT").ok()?;
    Some(format!("https://{host}:{port}"))
}

/// The pods on one node, as a path -> labels map.
pub async fn pods_on_node(
    client: &reqwest::Client,
    api: &str,
    node: &str,
) -> anyhow::Result<BTreeMap<String, BTreeMap<String, String>>> {
    let url = format!("{api}/api/v1/pods?fieldSelector=spec.nodeName%3D{node}");
    let response = client
        .get(&url)
        .bearer_auth(token()?)
        .send()
        .await?
        .error_for_status()?;

    Ok(paths_from_pod_list(&response.text().await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape observed on a GKE Container-Optimized node.
    #[test]
    fn burstable_pods_carry_their_qos_in_the_path() {
        assert_eq!(
            cgroup_path("4745b1d3-3d27-4586-90dc-aeeb97bbc517", "Burstable").as_deref(),
            Some(
                "kubepods.slice/kubepods-burstable.slice/\
                 kubepods-burstable-pod4745b1d3_3d27_4586_90dc_aeeb97bbc517.slice"
            )
        );
    }

    /// Guaranteed pods do not, and this asymmetry is the kubelet's rather than a simplification.
    #[test]
    fn guaranteed_pods_have_no_qos_level() {
        let path = cgroup_path("4745b1d3-3d27-4586-90dc-aeeb97bbc517", "Guaranteed").unwrap();

        assert!(!path.contains("guaranteed"));
        assert_eq!(
            path,
            "kubepods.slice/kubepods-pod4745b1d3_3d27_4586_90dc_aeeb97bbc517.slice"
        );
    }

    /// Underscores, not hyphens. A hyphen is a path separator in a systemd unit name, so the
    /// unescaped UID names a directory that does not exist — and an absent directory reads as an
    /// absent pod, which is billed as nothing at all.
    #[test]
    fn the_uid_is_systemd_escaped() {
        let path = cgroup_path("4745b1d3-3d27-4586-90dc-aeeb97bbc517", "Burstable").unwrap();

        assert!(!path.contains("4745b1d3-3d27"));
        assert!(path.contains("4745b1d3_3d27"));
    }

    #[test]
    fn an_unknown_qos_class_is_not_guessed_at() {
        assert_eq!(cgroup_path("abc", "Something"), None);
    }

    #[test]
    fn a_pod_list_becomes_paths_and_labels() {
        let body = r#"{"items":[
            {"metadata":{"uid":"11111111-2222-3333-4444-555555555555",
                         "labels":{"sproutos.dev/organization-id":"org"}},
             "status":{"qosClass":"Burstable"}},
            {"metadata":{"uid":"66666666-7777-8888-9999-000000000000","labels":{}},
             "status":{"qosClass":"Guaranteed"}}
        ]}"#;

        let paths = paths_from_pod_list(body);

        assert_eq!(paths.len(), 2);
        assert!(paths.contains_key(
            "kubepods.slice/kubepods-burstable.slice/\
             kubepods-burstable-pod11111111_2222_3333_4444_555555555555.slice"
        ));
    }

    /// A pod with no UID or no QoS class yet — one that has been created but not admitted — is
    /// skipped rather than given a path built from an empty string, which would collide with every
    /// other such pod.
    #[test]
    fn pods_without_a_uid_or_qos_are_skipped() {
        let body = r#"{"items":[
            {"metadata":{"labels":{}},"status":{"qosClass":"Burstable"}},
            {"metadata":{"uid":"abc","labels":{}},"status":{}}
        ]}"#;

        assert!(paths_from_pod_list(body).is_empty());
    }

    /// A body that is not a pod list at all — an error page from a proxy, say — yields nothing
    /// rather than panicking the sampler.
    #[test]
    fn a_malformed_body_yields_nothing() {
        assert!(paths_from_pod_list("<html>502</html>").is_empty());
    }
}
