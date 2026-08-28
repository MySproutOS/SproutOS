use std::{
    collections::BTreeSet,
    fmt,
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use oci_client::{
    Reference,
    client::{Client, ClientConfig},
    manifest::{OciImageManifest, OciManifest},
    secrets::RegistryAuth,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWrite;

use crate::{Result, Sha256Digest, SproutError};

pub const PLUGIN_MANIFEST_ARTIFACT_TYPE: &str = "application/vnd.sproutos.template-plugin.v1";
pub const PLUGIN_INDEX_ARTIFACT_TYPE: &str = "application/vnd.sproutos.template-plugin.index.v1";
pub const PLUGIN_EXECUTABLE_MEDIA_TYPE: &str =
    "application/vnd.sproutos.template-plugin.executable.v1";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginTarget {
    LinuxAmd64Musl,
    LinuxArm64Musl,
    DarwinAmd64,
    DarwinArm64,
    WindowsAmd64,
}

impl PluginTarget {
    pub const ALL: [Self; 5] = [
        Self::LinuxAmd64Musl,
        Self::LinuxArm64Musl,
        Self::DarwinAmd64,
        Self::DarwinArm64,
        Self::WindowsAmd64,
    ];

    pub fn oci_platform(self) -> (&'static str, &'static str) {
        match self {
            Self::LinuxAmd64Musl => ("linux", "amd64"),
            Self::LinuxArm64Musl => ("linux", "arm64"),
            Self::DarwinAmd64 => ("darwin", "amd64"),
            Self::DarwinArm64 => ("darwin", "arm64"),
            Self::WindowsAmd64 => ("windows", "amd64"),
        }
    }

    pub fn executable_name(self) -> &'static str {
        if self == Self::WindowsAmd64 {
            "plugin.exe"
        } else {
            "plugin"
        }
    }

    pub fn current() -> Result<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => Ok(Self::LinuxAmd64Musl),
            ("linux", "aarch64") => Ok(Self::LinuxArm64Musl),
            ("macos", "x86_64") => Ok(Self::DarwinAmd64),
            ("macos", "aarch64") => Ok(Self::DarwinArm64),
            ("windows", "x86_64") => Ok(Self::WindowsAmd64),
            (os, architecture) => Err(SproutError::ArtifactRejected(format!(
                "template plugins are not published for {os}/{architecture}"
            ))),
        }
    }
}

impl fmt::Display for PluginTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (os, architecture) = self.oci_platform();
        write!(formatter, "{os}/{architecture}")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ArtifactProvenance {
    pub repository: String,
    pub workflow: String,
    pub git_ref: String,
    pub source_commit: String,
    pub oidc_issuer: String,
    pub workflow_identity: String,
    pub github_hosted_runner: bool,
}

impl ArtifactProvenance {
    pub fn deployment_templates(source_commit: impl Into<String>) -> Self {
        Self {
            repository: "MySproutOS/Deployment-Templates".into(),
            workflow: ".github/workflows/publish.yml".into(),
            git_ref: "refs/heads/main".into(),
            source_commit: source_commit.into(),
            oidc_issuer: "https://token.actions.githubusercontent.com".into(),
            workflow_identity:
                "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main"
                    .into(),
            github_hosted_runner: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ArtifactLimits {
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    pub max_executable_bytes: u64,
}

impl Default for ArtifactLimits {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            read_timeout: Duration::from_secs(60),
            max_executable_bytes: 64 * 1024 * 1024,
        }
    }
}

#[async_trait]
pub trait ProvenanceVerifier: Send + Sync {
    /// Verify signed provenance for this exact manifest digest and expected source identity.
    /// Implementations may inspect OCI referrers, but must fail closed when evidence is absent.
    async fn verify(
        &self,
        reference: &Reference,
        root_digest: &Sha256Digest,
        selected_manifest_digest: &Sha256Digest,
        manifest: &OciImageManifest,
        expected: &ArtifactProvenance,
    ) -> Result<()>;
}

#[derive(Clone, Debug)]
pub struct VerifiedExecutable {
    path: PathBuf,
    manifest_digest: Sha256Digest,
}

impl VerifiedExecutable {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn manifest_digest(&self) -> &Sha256Digest {
        &self.manifest_digest
    }

    #[cfg(test)]
    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self {
            path,
            manifest_digest: Sha256Digest::from_bytes(b"test manifest"),
        }
    }
}

pub struct OciDownloader<V> {
    client: Client,
    verifier: V,
    limits: ArtifactLimits,
}

impl<V: ProvenanceVerifier> OciDownloader<V> {
    pub fn new(verifier: V, limits: ArtifactLimits) -> Self {
        let config = ClientConfig {
            connect_timeout: Some(limits.connect_timeout),
            read_timeout: Some(limits.read_timeout),
            max_concurrent_download: 1,
            ..ClientConfig::default()
        };
        Self {
            client: Client::new(config),
            verifier,
            limits,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn download_verified(
        &self,
        reference: &str,
        expected_digest: &Sha256Digest,
        target: PluginTarget,
        provenance: &ArtifactProvenance,
        auth: &RegistryAuth,
        destination: &Path,
    ) -> Result<VerifiedExecutable> {
        let reference = reference
            .parse::<Reference>()
            .map_err(|error| SproutError::ArtifactReference(error.to_string()))?;
        if reference.digest() != Some(expected_digest.as_str()) {
            return Err(SproutError::ArtifactReference(
                "plugin references must use @sha256:<digest> matching the catalogue".into(),
            ));
        }
        let (root_manifest, root_digest) = self
            .client
            .pull_manifest(&reference, auth)
            .await
            .map_err(|error| SproutError::ArtifactDownload(error.to_string()))?;
        let root_digest: Sha256Digest = root_digest.parse().map_err(|_| {
            SproutError::ArtifactRejected("registry returned a non-SHA256 index digest".into())
        })?;
        if &root_digest != expected_digest {
            return Err(SproutError::DigestMismatch {
                expected: expected_digest.to_string(),
                actual: root_digest.to_string(),
            });
        }
        let index = match root_manifest {
            OciManifest::ImageIndex(index) => index,
            OciManifest::Image(_) => {
                return Err(SproutError::ArtifactRejected(
                    "plugin reference must resolve to a multi-platform OCI index".into(),
                ));
            }
        };
        if index.schema_version != 2
            || index.artifact_type.as_deref() != Some(PLUGIN_INDEX_ARTIFACT_TYPE)
        {
            return Err(SproutError::ArtifactRejected(
                "plugin index has the wrong schema or artifact type".into(),
            ));
        }
        verify_source_annotations(index.annotations.as_ref(), provenance, "plugin index")?;
        let platforms: BTreeSet<_> = index
            .manifests
            .iter()
            .filter_map(|entry| {
                let platform = entry.platform.as_ref()?;
                Some((platform.os.to_string(), platform.architecture.to_string()))
            })
            .collect();
        let expected_platforms: BTreeSet<_> = PluginTarget::ALL
            .map(|target| {
                let (os, architecture) = target.oci_platform();
                (os.to_owned(), architecture.to_owned())
            })
            .into_iter()
            .collect();
        if platforms != expected_platforms || index.manifests.len() != PluginTarget::ALL.len() {
            return Err(SproutError::ArtifactRejected(
                "plugin index must contain exactly the five supported platforms".into(),
            ));
        }
        let (target_os, target_architecture) = target.oci_platform();
        let descriptor = index
            .manifests
            .iter()
            .find(|entry| {
                entry.platform.as_ref().is_some_and(|platform| {
                    platform.os.to_string() == target_os
                        && platform.architecture.to_string() == target_architecture
                })
            })
            .ok_or_else(|| {
                SproutError::ArtifactRejected(format!("plugin index has no {target} executable"))
            })?;
        if descriptor.artifact_type.as_deref() != Some(PLUGIN_MANIFEST_ARTIFACT_TYPE) {
            return Err(SproutError::ArtifactRejected(format!(
                "{target} descriptor has the wrong artifact type"
            )));
        }
        let selected_reference = reference.clone_with_digest(descriptor.digest.clone());
        let (selected_manifest, selected_digest) = self
            .client
            .pull_manifest(&selected_reference, auth)
            .await
            .map_err(|error| SproutError::ArtifactDownload(error.to_string()))?;
        let manifest = match selected_manifest {
            OciManifest::Image(manifest) => manifest,
            OciManifest::ImageIndex(_) => {
                return Err(SproutError::ArtifactRejected(
                    "platform descriptor resolved to another index".into(),
                ));
            }
        };
        let selected_digest: Sha256Digest = selected_digest.parse().map_err(|_| {
            SproutError::ArtifactRejected("registry returned a non-SHA256 manifest digest".into())
        })?;
        if selected_digest.as_str() != descriptor.digest {
            return Err(SproutError::DigestMismatch {
                expected: descriptor.digest.clone(),
                actual: selected_digest.to_string(),
            });
        }
        if manifest.schema_version != 2 {
            return Err(SproutError::ArtifactRejected(format!(
                "expected OCI schema version 2, got {}",
                manifest.schema_version
            )));
        }
        if manifest.artifact_type.as_deref() != Some(PLUGIN_MANIFEST_ARTIFACT_TYPE) {
            return Err(SproutError::ArtifactRejected(
                "platform manifest has the wrong artifact type".into(),
            ));
        }
        verify_source_annotations(
            manifest.annotations.as_ref(),
            provenance,
            "platform manifest",
        )?;
        if manifest.layers.len() != 1 {
            return Err(SproutError::ArtifactRejected(format!(
                "plugin artifact must contain exactly one executable layer, found {}",
                manifest.layers.len()
            )));
        }
        let layer = &manifest.layers[0];
        if layer.media_type != PLUGIN_EXECUTABLE_MEDIA_TYPE {
            return Err(SproutError::ArtifactRejected(format!(
                "expected executable layer media type {PLUGIN_EXECUTABLE_MEDIA_TYPE}, got {}",
                layer.media_type
            )));
        }
        let title = layer
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.get("org.opencontainers.image.title"));
        if title.map(String::as_str) != Some(target.executable_name()) {
            return Err(SproutError::ArtifactRejected(format!(
                "{target} executable layer must be titled {}",
                target.executable_name()
            )));
        }
        let declared_size = u64::try_from(layer.size).map_err(|_| {
            SproutError::ArtifactRejected("executable layer declared a negative size".into())
        })?;
        if declared_size > self.limits.max_executable_bytes {
            return Err(SproutError::ArtifactRejected(format!(
                "executable layer is {declared_size} bytes; limit is {}",
                self.limits.max_executable_bytes
            )));
        }

        self.verifier
            .verify(
                &reference,
                expected_digest,
                &selected_digest,
                &manifest,
                provenance,
            )
            .await?;

        let parent = destination.parent().ok_or_else(|| {
            SproutError::InvalidInput("plugin destination must have a parent directory".into())
        })?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|source| SproutError::Io {
                operation: "create plugin directory",
                source,
            })?;
        let file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .await
            .map_err(|source| SproutError::Io {
                operation: "create plugin executable",
                source,
            })?;
        let mut output = LimitedWriter::new(file, self.limits.max_executable_bytes);
        if let Err(error) = self
            .client
            .pull_blob(&selected_reference, layer, &mut output)
            .await
        {
            drop(output);
            let _ = tokio::fs::remove_file(destination).await;
            return Err(if output_limit_error(&error) {
                SproutError::ArtifactRejected(format!(
                    "downloaded executable exceeded {} bytes",
                    self.limits.max_executable_bytes
                ))
            } else {
                SproutError::ArtifactDownload(error.to_string())
            });
        }
        let downloaded_size = output.written;
        if downloaded_size != declared_size {
            drop(output);
            let _ = tokio::fs::remove_file(destination).await;
            return Err(SproutError::ArtifactRejected(format!(
                "executable layer declared {declared_size} bytes but downloaded {}",
                downloaded_size
            )));
        }
        drop(output);
        set_executable_permissions(destination).await?;

        Ok(VerifiedExecutable {
            path: destination.to_owned(),
            // The executable came from this platform manifest. The root index remains the
            // catalogue-pinned subject, but reporting it as the executable digest conflates two
            // different OCI objects and makes a cross-platform verification record ambiguous.
            manifest_digest: selected_digest,
        })
    }
}

fn verify_source_annotations(
    annotations: Option<&std::collections::BTreeMap<String, String>>,
    provenance: &ArtifactProvenance,
    artifact: &str,
) -> Result<()> {
    let annotations = annotations.ok_or_else(|| {
        SproutError::ArtifactRejected(format!("{artifact} has no OCI source annotations"))
    })?;
    let expected_source = format!("https://github.com/{}", provenance.repository);
    if annotations
        .get("org.opencontainers.image.source")
        .map(String::as_str)
        != Some(expected_source.as_str())
        || annotations
            .get("org.opencontainers.image.licenses")
            .map(String::as_str)
            != Some("Apache-2.0")
    {
        return Err(SproutError::ArtifactRejected(format!(
            "{artifact} source or license annotation does not match Deployment-Templates"
        )));
    }
    Ok(())
}

fn output_limit_error(error: &oci_client::errors::OciDistributionError) -> bool {
    error.to_string().contains("artifact byte limit exceeded")
}

struct LimitedWriter<W> {
    inner: W,
    limit: u64,
    written: u64,
}

impl<W> LimitedWriter<W> {
    fn new(inner: W, limit: u64) -> Self {
        Self {
            inner,
            limit,
            written: 0,
        }
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for LimitedWriter<W> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let remaining = self.limit.saturating_sub(self.written);
        if remaining == 0 && !buffer.is_empty() {
            return std::task::Poll::Ready(Err(std::io::Error::other(
                "artifact byte limit exceeded",
            )));
        }
        let allowed = buffer.len().min(remaining as usize);
        match std::pin::Pin::new(&mut self.inner).poll_write(context, &buffer[..allowed]) {
            std::task::Poll::Ready(Ok(count)) => {
                self.written += count as u64;
                std::task::Poll::Ready(Ok(count))
            }
            other => other,
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

#[cfg(unix)]
async fn set_executable_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o500))
        .await
        .map_err(|source| SproutError::Io {
            operation: "make plugin executable",
            source,
        })
}

#[cfg(windows)]
async fn set_executable_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ArtifactProvenance, PluginTarget};

    #[test]
    fn supported_targets_match_the_published_index_contract() {
        let platforms: Vec<_> = PluginTarget::ALL
            .map(|target| target.to_string())
            .into_iter()
            .collect();
        assert_eq!(
            platforms,
            [
                "linux/amd64",
                "linux/arm64",
                "darwin/amd64",
                "darwin/arm64",
                "windows/amd64",
            ]
        );
        assert_eq!(PluginTarget::WindowsAmd64.executable_name(), "plugin.exe");
    }

    #[test]
    fn provenance_policy_pins_github_identity_and_hosted_runner() {
        let policy = ArtifactProvenance::deployment_templates("a".repeat(40));
        assert_eq!(policy.git_ref, "refs/heads/main");
        assert_eq!(
            policy.oidc_issuer,
            "https://token.actions.githubusercontent.com"
        );
        assert!(
            policy
                .workflow_identity
                .ends_with("Deployment-Templates/.github/workflows/publish.yml@refs/heads/main")
        );
        assert!(policy.github_hosted_runner);
    }
}
