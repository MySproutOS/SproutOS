//! Keyless signature verification for immutable Deployment-Templates plugins.
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

/// Verifies keyless OCI signatures with a trusted, root-owned Cosign installation.
#[derive(Clone, Debug)]
pub struct CosignProvenanceVerifier {
    executable: PathBuf,
    timeout: Duration,
}

impl CosignProvenanceVerifier {
    /// Detect the production verifier. There is no PATH lookup or unsigned fallback.
    pub fn detect() -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};

            for candidate in ["/usr/local/bin/cosign", "/usr/bin/cosign"] {
                let Ok(executable) = PathBuf::from(candidate).canonicalize() else {
                    continue;
                };
                let Ok(metadata) = std::fs::metadata(&executable) else {
                    continue;
                };
                if metadata.is_file()
                    && metadata.uid() == 0
                    && metadata.permissions().mode() & 0o022 == 0
                {
                    return Ok(Self {
                        executable,
                        timeout: Duration::from_secs(60),
                    });
                }
            }
            Err(SproutError::ProvenanceRejected(
                "trusted cosign executable was not found at an approved system path".into(),
            ))
        }
        #[cfg(not(unix))]
        {
            Err(SproutError::ProvenanceRejected(
                "native keyless verification is not implemented on this platform".into(),
            ))
        }
    }

    #[cfg(test)]
    fn for_test(executable: PathBuf, timeout: Duration) -> Self {
        Self {
            executable,
            timeout,
        }
    }
}

#[async_trait]
impl ProvenanceVerifier for CosignProvenanceVerifier {
    async fn verify(
        &self,
        reference: &Reference,
        root_digest: &Sha256Digest,
        _selected_manifest_digest: &Sha256Digest,
        _manifest: &OciImageManifest,
        expected: &ArtifactProvenance,
    ) -> Result<()> {
        let identity = format!(
            "https://github.com/{}/{}@{}",
            expected.repository, expected.workflow, expected.git_ref
        );
        let subject = reference
            .clone_with_digest(root_digest.to_string())
            .to_string();
        let mut command = Command::new(&self.executable);
        command
            .args([
                "verify",
                "--certificate-identity",
                &identity,
                "--certificate-oidc-issuer",
                &expected.oidc_issuer,
                "--certificate-github-workflow-sha",
                &expected.source_commit,
                &subject,
            ])
            .env_clear()
            .env("HOME", "/tmp")
            .env("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SproutError::ProvenanceRejected("cosign did not provide a diagnostic stream".into())
        })?;
        let diagnostic = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr
                .take((MAX_DIAGNOSTIC_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        });
        let status = match tokio::time::timeout(self.timeout, child.wait()).await {
            Ok(status) => {
                status.map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?
            }
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(SproutError::ProvenanceRejected(
                    "cosign verification timed out".into(),
                ));
            }
        };
        let diagnostic = diagnostic
            .await
            .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?
            .map_err(|error| SproutError::ProvenanceRejected(error.to_string()))?;
        if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
            return Err(SproutError::ProvenanceRejected(
                "cosign diagnostic exceeded its output limit".into(),
            ));
        }
        if !status.success() {
            let diagnostic = String::from_utf8_lossy(&diagnostic).trim().to_owned();
            return Err(SproutError::ProvenanceRejected(if diagnostic.is_empty() {
                format!("cosign exited with {status}")
            } else {
                diagnostic
            }));
        }
        Ok(())
    }
}

#[cfg(test)]
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
        let verifier = CosignProvenanceVerifier::for_test(executable, Duration::from_secs(2));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        verifier
            .verify(
                &reference,
                &digest,
                &digest,
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
        let verifier = CosignProvenanceVerifier::for_test(executable, Duration::from_secs(2));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();

        verifier
            .verify(
                &reference,
                &digest,
                &digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates(signed_commit),
            )
            .await
            .unwrap();

        let error = verifier
            .verify(
                &reference,
                &digest,
                &digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("d".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("wrong-source-commit"));
    }

    #[tokio::test]
    async fn fails_closed_on_cosign_refusal() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("cosign");
        fs::write(&executable, "#!/bin/sh\necho unsigned >&2\nexit 1\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        // This is not the timeout test: give a loaded parallel test runner enough time to observe
        // the verifier's deliberate refusal and retain its diagnostic.
        let verifier = CosignProvenanceVerifier::for_test(executable, Duration::from_secs(5));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        let error = verifier
            .verify(
                &reference,
                &digest,
                &digest,
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
        let verifier = CosignProvenanceVerifier::for_test(executable, Duration::from_millis(50));
        let digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let reference: Reference = "ghcr.io/mysproutos/template-umami@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        let error = verifier
            .verify(
                &reference,
                &digest,
                &digest,
                &manifest(),
                &ArtifactProvenance::deployment_templates("c".repeat(40)),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
