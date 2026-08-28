use std::path::Path;

use async_trait::async_trait;
use oci_client::secrets::RegistryAuth;
use serde::Serialize;

use crate::{
    ApplyLimits, ApplyResult, ArtifactLimits, CanonicalProtocol, CatalogueResolver,
    IsolationProvider, OciDownloader, PluginRunner, PluginTarget, ProvenanceVerifier,
    ResolvedTemplate, Result, SproutError, TemplateSelector, VerifiedExecutable,
    validate_resolution,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TemplateVerification {
    pub template_id: String,
    pub upstream_commit: String,
    pub plugin_reference: String,
    pub plugin_digest: crate::Sha256Digest,
    pub target: PluginTarget,
    pub source_commit: String,
    pub manifest_digest: crate::Sha256Digest,
}

#[derive(Debug, Serialize)]
pub struct TemplateApplication {
    pub verification: TemplateVerification,
    pub result: ApplyResult,
}

pub async fn resolve_template<R: CatalogueResolver>(
    resolver: &R,
    selector: &TemplateSelector,
) -> Result<ResolvedTemplate> {
    let resolved = resolver.resolve(selector).await?;
    validate_resolution(selector, &resolved)?;
    Ok(resolved)
}

pub async fn verify_template<V: ProvenanceVerifier>(
    resolved: &ResolvedTemplate,
    verifier: V,
    limits: ArtifactLimits,
) -> Result<TemplateVerification> {
    verify_with(
        resolved,
        &OciArtifactProvider {
            downloader: OciDownloader::new(verifier, limits),
        },
    )
    .await
}

async fn verify_with<P: ArtifactProvider>(
    resolved: &ResolvedTemplate,
    provider: &P,
) -> Result<TemplateVerification> {
    validate_resolved(resolved)?;
    let temporary = tempfile::tempdir().map_err(|source| SproutError::Io {
        operation: "create verified plugin directory",
        source,
    })?;
    let destination = temporary.path().join(resolved.target.executable_name());
    let executable = provider.download(resolved, &destination).await?;
    Ok(verification(resolved, executable.manifest_digest().clone()))
}

pub async fn apply_template<V, I>(
    resolved: &ResolvedTemplate,
    workspace: &Path,
    verifier: V,
    isolation: I,
    artifact_limits: ArtifactLimits,
    apply_limits: ApplyLimits,
) -> Result<TemplateApplication>
where
    V: ProvenanceVerifier,
    I: IsolationProvider,
{
    apply_with(
        resolved,
        workspace,
        &OciArtifactProvider {
            downloader: OciDownloader::new(verifier, artifact_limits),
        },
        isolation,
        apply_limits,
    )
    .await
}

async fn apply_with<P, I>(
    resolved: &ResolvedTemplate,
    workspace: &Path,
    provider: &P,
    isolation: I,
    apply_limits: ApplyLimits,
) -> Result<TemplateApplication>
where
    P: ArtifactProvider,
    I: IsolationProvider,
{
    validate_resolved(resolved)?;
    let current = PluginTarget::current()?;
    if resolved.target != current {
        return Err(SproutError::ArtifactRejected(format!(
            "cannot execute a {} plugin on {}; omit --target or select the current platform",
            resolved.target, current
        )));
    }
    let temporary = tempfile::tempdir().map_err(|source| SproutError::Io {
        operation: "create verified plugin directory",
        source,
    })?;
    let destination = temporary.path().join(resolved.target.executable_name());
    let executable = provider.download(resolved, &destination).await?;
    let verification = verification(resolved, executable.manifest_digest().clone());
    let result = PluginRunner::new(isolation, apply_limits)
        .apply(
            &executable,
            workspace,
            &CanonicalProtocol,
            &resolved.request,
        )
        .await?;
    Ok(TemplateApplication {
        verification,
        result,
    })
}

#[async_trait]
trait ArtifactProvider: Send + Sync {
    async fn download(
        &self,
        resolved: &ResolvedTemplate,
        destination: &Path,
    ) -> Result<VerifiedExecutable>;
}

struct OciArtifactProvider<V> {
    downloader: OciDownloader<V>,
}

#[async_trait]
impl<V: ProvenanceVerifier> ArtifactProvider for OciArtifactProvider<V> {
    async fn download(
        &self,
        resolved: &ResolvedTemplate,
        destination: &Path,
    ) -> Result<VerifiedExecutable> {
        self.downloader
            .download_verified(
                &resolved.plugin_reference,
                &resolved.plugin_digest,
                resolved.target,
                &resolved.provenance,
                &RegistryAuth::Anonymous,
                destination,
            )
            .await
    }
}

fn validate_resolved(resolved: &ResolvedTemplate) -> Result<()> {
    validate_resolution(
        &TemplateSelector {
            template_id: resolved.template_id.clone(),
            upstream_commit: resolved.upstream_commit.clone(),
            target: resolved.target,
        },
        resolved,
    )
}

fn verification(
    resolved: &ResolvedTemplate,
    manifest_digest: crate::Sha256Digest,
) -> TemplateVerification {
    TemplateVerification {
        template_id: resolved.template_id.clone(),
        upstream_commit: resolved.upstream_commit.clone(),
        plugin_reference: resolved.plugin_reference.clone(),
        plugin_digest: resolved.plugin_digest.clone(),
        target: resolved.target,
        source_commit: resolved.provenance.source_commit.clone(),
        manifest_digest,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};

    use tokio::process::Command;

    use super::*;
    use crate::{ArtifactProvenance, IsolatedCommand, Sha256Digest};

    struct TestProvider;

    #[async_trait]
    impl ArtifactProvider for TestProvider {
        async fn download(
            &self,
            _resolved: &ResolvedTemplate,
            destination: &Path,
        ) -> Result<VerifiedExecutable> {
            fs::write(
                destination,
                r#"#!/bin/sh
set -eu
cat >/dev/null
if [ -f generated.txt ]; then
  test "$(cat generated.txt)" = created
  printf '{"status":"ok","protocol_version":1,"changes":[],"warnings":[]}'
else
  printf created > generated.txt
  printf '{"status":"ok","protocol_version":1,"changes":[{"path":"generated.txt","kind":"created","before_sha256":null,"after_sha256":"sha256:406effb1e9c59672c66a598c2b21e331b23b16c54024e96d6df3e7c173549791"}],"warnings":[]}'
fi
"#,
            )
            .unwrap();
            fs::set_permissions(destination, fs::Permissions::from_mode(0o700)).unwrap();
            Ok(VerifiedExecutable::for_test(destination.to_owned()))
        }
    }

    struct TestIsolation;

    impl IsolationProvider for TestIsolation {
        fn command(
            &self,
            executable: &VerifiedExecutable,
            _workspace: &Path,
        ) -> Result<IsolatedCommand> {
            Ok(IsolatedCommand::new(Command::new(executable.path())))
        }
    }

    fn resolved() -> ResolvedTemplate {
        let plugin_digest: Sha256Digest = format!("sha256:{}", "a".repeat(64)).parse().unwrap();
        let upstream_commit = "b".repeat(40);
        ResolvedTemplate {
            template_id: "starter".into(),
            upstream_commit: upstream_commit.clone(),
            plugin_reference: format!("ghcr.io/mysproutos/template-starter@{plugin_digest}"),
            plugin_digest: plugin_digest.clone(),
            target: PluginTarget::current().unwrap(),
            provenance: ArtifactProvenance::deployment_templates("c".repeat(40)),
            request: serde_json::from_value(serde_json::json!({
                "protocol_version": 1,
                "workspace": "/workspace",
                "template": {
                    "id": "starter",
                    "catalogue_digest": format!("sha256:{}", "d".repeat(64)),
                    "manifest_digest": format!("sha256:{}", "e".repeat(64)),
                    "plugin_digest": plugin_digest,
                    "upstream_repository": "https://github.com/MySproutOS/starter",
                    "upstream_commit": upstream_commit
                },
                "deployment": {"preset": "web", "capabilities": []},
                "services": [],
                "user_inputs": [],
                "generated_inputs": []
            }))
            .unwrap(),
        }
    }

    #[tokio::test]
    async fn verify_reports_exact_digest_source_commit_and_platform_manifest() {
        let resolved = resolved();
        let verification = verify_with(&resolved, &TestProvider).await.unwrap();
        assert_eq!(verification.plugin_digest, resolved.plugin_digest);
        assert_eq!(verification.source_commit, "c".repeat(40));
        assert_eq!(
            verification.manifest_digest,
            Sha256Digest::from_bytes(b"test manifest")
        );
    }

    #[tokio::test]
    async fn apply_uses_the_same_verified_path_and_is_idempotent() {
        let workspace = tempfile::tempdir().unwrap();
        let resolved = resolved();
        let first = apply_with(
            &resolved,
            workspace.path(),
            &TestProvider,
            TestIsolation,
            ApplyLimits::default(),
        )
        .await
        .unwrap();
        let second = apply_with(
            &resolved,
            workspace.path(),
            &TestProvider,
            TestIsolation,
            ApplyLimits::default(),
        )
        .await
        .unwrap();
        assert_eq!(first.result.changes.len(), 1);
        assert!(second.result.changes.is_empty());
        assert_eq!(first.verification, second.verification);
        assert_eq!(
            fs::read(workspace.path().join("generated.txt")).unwrap(),
            b"created"
        );
    }
}
