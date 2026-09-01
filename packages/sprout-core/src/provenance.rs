//! Keyless signature and GitHub SLSA attestation verification for immutable
//! Deployment-Templates plugins.
//!
//! The catalogue import verifies the signed catalogue and its SLSA attestation. Execution still
//! verifies the exact plugin index it downloads: otherwise a compromised registry could answer a
//! content-addressed reference with unsigned bytes and the worker would be relying on the registry
//! to enforce the digest it is meant to distrust.

use std::{path::PathBuf, process::Stdio, time::Duration};

use async_trait::async_trait;
use oci_client::{Reference, manifest::OciImageManifest};
use tokio::{io::AsyncReadExt, process::Command};

use crate::{ArtifactProvenance, ProvenanceVerifier, Result, Sha256Digest, SproutError};

const MAX_DIAGNOSTIC_BYTES: usize = 256 * 1024;

/// Verifies keyless OCI signatures and GitHub-hosted SLSA attestations with approved tools.
#[derive(Clone, Debug)]
pub struct CosignProvenanceVerifier {
    cosign: PathBuf,
    github_cli: PathBuf,
    timeout: Duration,
}

impl CosignProvenanceVerifier {
    /// Detect the production verifier. There is no PATH lookup or unsigned fallback.
    pub fn detect() -> Result<Self> {
        #[cfg(unix)]
        {
            let cosign = find_unix_tool(
                &[
                    "/opt/homebrew/bin/cosign",
                    "/usr/local/bin/cosign",
                    "/usr/bin/cosign",
                ],
                "cosign",
            )?;
            let github_cli = find_unix_tool(
                &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"],
                "GitHub CLI",
            )?;
            Ok(Self {
                cosign,
                github_cli,
                timeout: Duration::from_secs(60),
            })
        }
        #[cfg(windows)]
        {
            let program_files = std::env::var_os("ProgramFiles").ok_or_else(|| {
                SproutError::ProvenanceRejected("ProgramFiles is unavailable".into())
            })?;
            let root = PathBuf::from(program_files);
            let cosign = find_windows_tool(
                &[
                    root.join("cosign/cosign.exe"),
                    root.join("Cosign/cosign.exe"),
                ],
                "cosign",
            )?;
            let github_cli = find_windows_tool(&[root.join("GitHub CLI/gh.exe")], "GitHub CLI")?;
            Ok(Self {
                cosign,
                github_cli,
                timeout: Duration::from_secs(60),
            })
        }
    }

    #[cfg(all(test, unix))]
    fn for_test(cosign: PathBuf, github_cli: PathBuf, timeout: Duration) -> Self {
        Self {
            cosign,
            github_cli,
            timeout,
        }
    }
}

#[cfg(unix)]
fn find_unix_tool(candidates: &[&str], name: &str) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    for candidate in candidates {
        let Ok(path) = PathBuf::from(candidate).canonicalize() else {
            continue;
        };
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        // Homebrew's standard /opt/homebrew installation is user-owned. Refusing group/world
        // writable tools preserves the local trust boundary without excluding that supported
        // installation layout.
        if metadata.is_file() && metadata.permissions().mode() & 0o022 == 0 {
            return Ok(path);
        }
    }
    Err(SproutError::ProvenanceRejected(format!(
        "trusted {name} executable was not found at an approved system path"
    )))
}

#[cfg(windows)]
fn find_windows_tool(candidates: &[PathBuf], name: &str) -> Result<PathBuf> {
    for candidate in candidates {
        let Ok(path) = candidate.canonicalize() else {
            continue;
        };
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(SproutError::ProvenanceRejected(format!(
        "trusted {name} executable was not found under Program Files"
    )))
}

#[async_trait]
impl ProvenanceVerifier for CosignProvenanceVerifier {
    async fn verify(
        &self,
        reference: &Reference,
        root_digest: &Sha256Digest,
        selected_manifest_digest: &Sha256Digest,
        manifest: &OciImageManifest,
        expected: &ArtifactProvenance,
    ) -> Result<()> {
        // The root index is the signed and attested subject. Its platform descriptor pins this
        // selected manifest, and oci-client has already checked the downloaded raw bytes against
        // that descriptor digest. Require the publisher's canonical manifest encoding here too:
        // this keeps the exact platform object in the provenance boundary instead of accepting a
        // parsed structure while silently ignoring the digest passed to this verifier.
        let encoded_manifest = encode_published_manifest(manifest).map_err(|error| {
            SproutError::ProvenanceRejected(format!(
                "could not encode selected platform manifest: {error}"
            ))
        })?;
        let encoded_digest = Sha256Digest::from_bytes(&encoded_manifest);
        if &encoded_digest != selected_manifest_digest {
            return Err(SproutError::ProvenanceRejected(format!(
                "selected platform manifest is not the canonical object at {selected_manifest_digest}"
            )));
        }
        let identity = format!(
            "https://github.com/{}/{}@{}",
            expected.repository, expected.workflow, expected.git_ref
        );
        let subject = reference
            .clone_with_digest(root_digest.to_string())
            .to_string();
        run_verifier(
            &self.cosign,
            &[
                "verify",
                "--certificate-identity",
                &identity,
                "--certificate-oidc-issuer",
                &expected.oidc_issuer,
                "--certificate-github-workflow-sha",
                &expected.source_commit,
                &subject,
            ],
            self.timeout,
            "cosign",
            false,
        )
        .await?;

        let signer_workflow = format!("{}/{}", expected.repository, expected.workflow);
        let oci_subject = format!("oci://{subject}");
        run_verifier(
            &self.github_cli,
            &[
                "attestation",
                "verify",
                &oci_subject,
                "--repo",
                &expected.repository,
                "--signer-workflow",
                &signer_workflow,
                "--cert-oidc-issuer",
                &expected.oidc_issuer,
                "--source-ref",
                &expected.git_ref,
                "--source-digest",
                &expected.source_commit,
                "--deny-self-hosted-runners",
                "--bundle-from-oci",
                "--format=json",
            ],
            self.timeout,
            "GitHub attestation",
            true,
        )
        .await?;
        Ok(())
    }
}

fn encode_published_manifest(manifest: &OciImageManifest) -> serde_json::Result<Vec<u8>> {
    // Deployment-Templates deliberately emits this stable field order. oci-client verifies the
    // raw response digest before parsing; reconstructing that one allowed encoding makes the
    // verifier independently consume both the selected digest and its manifest structure.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PublishedManifest<'a> {
        schema_version: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: &'a Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        artifact_type: &'a Option<String>,
        config: &'a oci_client::manifest::OciDescriptor,
        layers: &'a [oci_client::manifest::OciDescriptor],
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: &'a Option<std::collections::BTreeMap<String, String>>,
    }

    if manifest.subject.is_some() {
        return Err(serde::ser::Error::custom(
            "published platform manifests must not have a subject",
        ));
    }
    serde_json::to_vec(&PublishedManifest {
        schema_version: manifest.schema_version,
        media_type: &manifest.media_type,
        artifact_type: &manifest.artifact_type,
        config: &manifest.config,
        layers: &manifest.layers,
        annotations: &manifest.annotations,
    })
}

async fn run_verifier(
    executable: &PathBuf,
    arguments: &[&str],
    timeout: Duration,
    name: &str,
    require_attestation: bool,
) -> Result<()> {
    let home =
        tempfile::tempdir().map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env_clear()
        .env("HOME", home.path())
        .env("GH_CONFIG_DIR", home.path())
        .env("TMPDIR", home.path())
        .env("TMP", home.path())
        .env("TEMP", home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if require_attestation {
        // `--bundle-from-oci` performs offline bundle verification, but gh still requires this
        // variable to be non-empty before entering that code path. A fixed non-credential keeps
        // user and GitHub Actions tokens outside the verifier process.
        command.env("GH_TOKEN", "public-oci-bundle-verification");
    }
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }

    let mut child = command
        .spawn()
        .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SproutError::ProvenanceRejected(format!("{name} did not provide stdout")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| SproutError::ProvenanceRejected(format!("{name} did not provide stderr")))?;
    let output = |stream: tokio::process::ChildStdout| async move {
        let mut bytes = Vec::new();
        stream
            .take((MAX_DIAGNOSTIC_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    };
    let stdout_task = tokio::spawn(output(stdout));
    let diagnostic = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr
            .take((MAX_DIAGNOSTIC_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status.map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(SproutError::ProvenanceRejected(format!(
                "{name} verification timed out"
            )));
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?
        .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
    let diagnostic = diagnostic
        .await
        .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?
        .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
    if stdout.len() > MAX_DIAGNOSTIC_BYTES || diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
        return Err(SproutError::ProvenanceRejected(format!(
            "{name} output exceeded its limit"
        )));
    }
    if !status.success() {
        let diagnostic = String::from_utf8_lossy(&diagnostic).trim().to_owned();
        return Err(SproutError::ProvenanceRejected(if diagnostic.is_empty() {
            format!("{name} exited with {status}")
        } else {
            diagnostic
        }));
    }
    if require_attestation {
        let value: serde_json::Value = serde_json::from_slice(&stdout).map_err(|_| {
            SproutError::ProvenanceRejected(
                "GitHub returned malformed attestation verification output".into(),
            )
        })?;
        if value.as_array().is_none_or(|items| items.is_empty()) {
            return Err(SproutError::ProvenanceRejected(
                "GitHub returned no verified provenance attestation".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use oci_client::{Reference, manifest::OciImageManifest};
    use tempfile::tempdir;

    use super::*;

    fn manifest() -> OciImageManifest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "config": {"mediaType": "application/vnd.oci.empty.v1+json", "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 2},
            "layers": []
        }))
        .unwrap()
    }

    fn manifest_digest() -> Sha256Digest {
        Sha256Digest::from_bytes(&encode_published_manifest(&manifest()).unwrap())
    }

    fn github_cli(directory: &std::path::Path) -> PathBuf {
        let executable = directory.join("gh");
        fs::write(&executable, "#!/bin/sh\nprintf '[{}]'").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }

    #[tokio::test]
    async fn pins_identity_issuer_and_exact_digest_without_a_shell() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("cosign");
        let arguments = directory.path().join("arguments");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
                arguments.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier = CosignProvenanceVerifier::for_test(
            executable,
            github_cli(directory.path()),
            Duration::from_secs(5),
        );
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap();
        let arguments = fs::read_to_string(arguments).unwrap();
        assert!(arguments.contains("--certificate-identity"));
        assert!(arguments.contains(
            "https://github.com/MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main"
        ));
        assert!(arguments.contains("https://token.actions.githubusercontent.com"));
        assert!(arguments.contains("--certificate-github-workflow-sha"));
        assert!(arguments.contains(&"c".repeat(40)));
        assert!(arguments.contains(&digest.to_string()));
    }

    #[tokio::test]
    async fn pins_the_exact_source_commit_from_the_signing_certificate() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("cosign");
        let signed_commit = "c".repeat(40);
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --certificate-github-workflow-sha ]; then\n    shift\n    [ \"$1\" = '{signed_commit}' ] && exit 0\n    echo wrong-source-commit >&2\n    exit 1\n  fi\n  shift\ndone\necho missing-source-commit >&2\nexit 1\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier = CosignProvenanceVerifier::for_test(
            executable,
            github_cli(directory.path()),
            Duration::from_secs(5),
        );
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();

        verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates(signed_commit),
            )
            .await
            .unwrap();

        let error = verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("d".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("wrong-source-commit"));
    }

    #[tokio::test]
    async fn verifies_canonical_github_slsa_attestation_and_hosted_runner_policy() {
        let directory = tempdir().unwrap();
        let cosign = directory.path().join("cosign");
        fs::write(&cosign, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&cosign, fs::Permissions::from_mode(0o700)).unwrap();
        let github_cli = directory.path().join("gh");
        let arguments = directory.path().join("gh-arguments");
        fs::write(
            &github_cli,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '[{{}}]'\n",
                arguments.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&github_cli, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier =
            CosignProvenanceVerifier::for_test(cosign, github_cli, Duration::from_secs(5));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = format!("ghcr.io/mysproutos/umami-plugin@{digest}")
            .parse()
            .unwrap();
        verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap();
        let arguments = fs::read_to_string(arguments).unwrap();
        for expected in [
            "attestation",
            "verify",
            "--repo",
            "MySproutOS/Deployment-Templates",
            "--signer-workflow",
            "MySproutOS/Deployment-Templates/.github/workflows/publish.yml",
            "--source-ref",
            "refs/heads/main",
            "--source-digest",
            &"c".repeat(40),
            "--deny-self-hosted-runners",
            "--bundle-from-oci",
            "--format=json",
        ] {
            assert!(arguments.lines().any(|argument| argument == expected));
        }
    }

    #[tokio::test]
    async fn rejects_a_selected_manifest_digest_that_does_not_match_its_bytes() {
        let directory = tempdir().unwrap();
        let cosign = directory.path().join("cosign");
        let marker = directory.path().join("cosign-ran");
        fs::write(
            &cosign,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&cosign, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier = CosignProvenanceVerifier::for_test(
            cosign,
            github_cli(directory.path()),
            Duration::from_secs(5),
        );
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let wrong_selected: Sha256Digest = format!("sha256:{}", "d".repeat(64)).parse().unwrap();
        let reference: Reference = format!("ghcr.io/mysproutos/umami-plugin@{digest}")
            .parse()
            .unwrap();

        let error = verifier
            .verify(
                &reference,
                &digest,
                &wrong_selected,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("selected platform manifest"));
        assert!(!marker.exists(), "Cosign ran before manifest validation");
    }

    #[tokio::test]
    async fn rejects_when_github_returns_no_verified_attestation() {
        let directory = tempdir().unwrap();
        let cosign = directory.path().join("cosign");
        fs::write(&cosign, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&cosign, fs::Permissions::from_mode(0o700)).unwrap();
        let github_cli = directory.path().join("gh");
        fs::write(&github_cli, "#!/bin/sh\nprintf '[]'\n").unwrap();
        fs::set_permissions(&github_cli, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier =
            CosignProvenanceVerifier::for_test(cosign, github_cli, Duration::from_secs(5));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = format!("ghcr.io/mysproutos/umami-plugin@{digest}")
            .parse()
            .unwrap();
        let error = verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("no verified provenance attestation")
        );
    }

    #[tokio::test]
    async fn fails_closed_on_cosign_refusal() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("cosign");
        fs::write(&executable, "#!/bin/sh\necho unsigned >&2\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        // This is not the timeout test: give a loaded parallel test runner enough time to observe
        // the verifier's deliberate refusal and retain its diagnostic.
        let verifier = CosignProvenanceVerifier::for_test(
            executable,
            github_cli(directory.path()),
            Duration::from_secs(5),
        );
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        let error = verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unsigned"));
    }

    #[tokio::test]
    async fn fails_closed_when_cosign_times_out() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("cosign");
        fs::write(&executable, "#!/bin/sh\nexec sleep 10\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let verifier = CosignProvenanceVerifier::for_test(
            executable,
            github_cli(directory.path()),
            Duration::from_millis(50),
        );
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let selected_digest = manifest_digest();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        let error = verifier
            .verify(
                &reference,
                &digest,
                &selected_digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
