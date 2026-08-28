use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use reqwest::Method;

use crate::{ApiClient, ArtifactProvenance, PluginTarget, Result, Sha256Digest, SproutError};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TemplateSelector {
    pub template_id: String,
    pub upstream_commit: String,
    pub target: PluginTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ResolvedTemplate {
    pub template_id: String,
    pub upstream_commit: String,
    pub plugin_reference: String,
    pub plugin_digest: Sha256Digest,
    pub target: PluginTarget,
    pub provenance: ArtifactProvenance,
    pub request: sprout_template_protocol::ApplyRequest,
}

#[async_trait]
pub trait CatalogueResolver: Send + Sync {
    async fn resolve(&self, selector: &TemplateSelector) -> Result<ResolvedTemplate>;
}

/// Resolves only catalogue rows the control plane already imported from the signed,
/// content-addressed Deployment-Templates catalogue.
#[derive(Clone)]
pub struct ApiCatalogueResolver {
    client: ApiClient,
}

impl ApiCatalogueResolver {
    pub fn new(client: ApiClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl CatalogueResolver for ApiCatalogueResolver {
    async fn resolve(&self, selector: &TemplateSelector) -> Result<ResolvedTemplate> {
        let resolved: ResolvedTemplate = self
            .client
            .request_json(Method::POST, "v1/templates/resolve", Some(selector))
            .await?;
        validate_resolution(selector, &resolved)?;
        Ok(resolved)
    }
}

/// Re-check the security-critical catalogue coordinates at the native consumer boundary.
/// Database provenance is evidence, not permission to loosen the one trusted publisher policy.
pub fn validate_resolution(selector: &TemplateSelector, resolved: &ResolvedTemplate) -> Result<()> {
    if resolved.template_id != selector.template_id
        || resolved.upstream_commit != selector.upstream_commit
        || resolved.target != selector.target
    {
        return Err(SproutError::ArtifactRejected(
            "catalogue resolution does not match the requested template, commit, and target".into(),
        ));
    }
    let expected = ArtifactProvenance::deployment_templates(&resolved.provenance.source_commit);
    if resolved.provenance != expected
        || resolved.provenance.source_commit.len() != 40
        || !resolved
            .provenance
            .source_commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SproutError::ProvenanceRejected(
            "catalogue resolution did not use the trusted Deployment-Templates publisher policy"
                .into(),
        ));
    }
    let expected_reference_suffix = format!("@{}", resolved.plugin_digest);
    if !resolved.plugin_reference.starts_with("ghcr.io/mysproutos/")
        || !resolved
            .plugin_reference
            .ends_with(&expected_reference_suffix)
    {
        return Err(SproutError::ArtifactReference(
            "catalogue plugin must be an immutable MySproutOS GHCR digest reference".into(),
        ));
    }
    let identity = &resolved.request.template;
    let catalogue_digest = identity.catalogue_digest.parse::<Sha256Digest>();
    let manifest_digest = identity.manifest_digest.parse::<Sha256Digest>();
    if resolved.request.protocol_version != sprout_template_protocol::PROTOCOL_VERSION
        || resolved.request.workspace != "/workspace"
        || identity.id != resolved.template_id
        || identity.upstream_commit != resolved.upstream_commit
        || identity.plugin_digest != resolved.plugin_digest.to_string()
        || catalogue_digest.is_err()
        || manifest_digest.is_err()
    {
        return Err(SproutError::ProtocolViolation(
            "catalogue protocol request does not match the resolved immutable identity".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (TemplateSelector, ResolvedTemplate) {
        let selector = TemplateSelector {
            template_id: "starter".into(),
            upstream_commit: "a".repeat(40),
            target: PluginTarget::LinuxAmd64Musl,
        };
        let plugin_digest: Sha256Digest = format!("sha256:{}", "b".repeat(64)).parse().unwrap();
        let resolved = ResolvedTemplate {
            template_id: selector.template_id.clone(),
            upstream_commit: selector.upstream_commit.clone(),
            plugin_reference: format!("ghcr.io/mysproutos/template-starter@{plugin_digest}"),
            plugin_digest: plugin_digest.clone(),
            target: selector.target,
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
                    "upstream_commit": "a".repeat(40)
                },
                "deployment": {"preset": "web", "capabilities": []},
                "services": [],
                "user_inputs": [],
                "generated_inputs": []
            }))
            .unwrap(),
        };
        (selector, resolved)
    }

    #[test]
    fn accepts_only_the_exact_selector_digest_and_publisher_policy() {
        let (selector, resolved) = fixture();
        validate_resolution(&selector, &resolved).unwrap();

        let (_, mut wrong_commit) = fixture();
        wrong_commit.upstream_commit = "f".repeat(40);
        assert_eq!(
            validate_resolution(&selector, &wrong_commit)
                .unwrap_err()
                .code(),
            crate::ErrorCode::ArtifactRejected
        );

        let (_, mut wrong_digest) = fixture();
        wrong_digest.plugin_reference = format!(
            "ghcr.io/mysproutos/template-starter@sha256:{}",
            "0".repeat(64)
        );
        assert_eq!(
            validate_resolution(&selector, &wrong_digest)
                .unwrap_err()
                .code(),
            crate::ErrorCode::ArtifactReference
        );

        let (_, mut wrong_policy) = fixture();
        wrong_policy.provenance.workflow = ".github/workflows/attacker.yml".into();
        assert_eq!(
            validate_resolution(&selector, &wrong_policy)
                .unwrap_err()
                .code(),
            crate::ErrorCode::ProvenanceRejected
        );
    }

    #[test]
    fn rejects_protocol_identity_tampering() {
        let (selector, mut resolved) = fixture();
        resolved.request.template.plugin_digest = format!("sha256:{}", "f".repeat(64));
        assert_eq!(
            validate_resolution(&selector, &resolved)
                .unwrap_err()
                .code(),
            crate::ErrorCode::ProtocolViolation
        );
    }
}
