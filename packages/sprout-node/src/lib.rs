//! Narrow Node boundary for the shared deployment-template engine.
//!
//! This crate parses one request and delegates resolution, content-addressed download, keyless
//! signature verification, isolation, protocol validation and diff validation to `sprout-core`.
//! It deliberately exposes no command runner and contains no Git or deployment orchestration.

use napi::{Error, Status};
use napi_derive::napi;
use oci_client::secrets::RegistryAuth;
use serde::Deserialize;
use sprout_core::{
    ApplyLimits, ArtifactLimits, ArtifactProvenance, CanonicalProtocol, CosignProvenanceVerifier,
    NativeIsolationProvider, OciDownloader, PluginRunner, PluginTarget, Sha256Digest, SproutError,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApplyTemplateInput {
    workspace_path: String,
    plugin_reference: String,
    plugin_digest: String,
    deployment_templates_commit: String,
    request: sprout_template_protocol::ApplyRequest,
}

/// Apply one catalogue-pinned template and return the canonical protocol response plus verified
/// workspace diff as JSON. A JSON string keeps the N-API surface versioned by the canonical schema
/// instead of generating a second set of JavaScript structs that can drift from it.
#[napi]
pub async fn apply_template_json(input_json: String) -> napi::Result<String> {
    apply(input_json).await.map_err(napi_error)
}

/// Check that the native verifier and isolation backend required in production are present.
/// Individual jobs detect them again so a stale preflight cannot authorize a later execution.
#[napi]
pub fn native_runtime_status_json() -> napi::Result<String> {
    NativeIsolationProvider::detect().map_err(napi_error)?;
    CosignProvenanceVerifier::detect().map_err(napi_error)?;
    let target = PluginTarget::current().map_err(napi_error)?;
    Ok(serde_json::json!({
        "available": true,
        "pluginTarget": target.to_string(),
    })
    .to_string())
}

async fn apply(input_json: String) -> sprout_core::Result<String> {
    let input: ApplyTemplateInput = serde_json::from_str(&input_json).map_err(|error| {
        SproutError::InvalidInput(format!("invalid applyTemplate input: {error}"))
    })?;
    validate(&input)?;

    let workspace = std::path::Path::new(&input.workspace_path);
    if !workspace.join(".git").is_dir() {
        return Err(SproutError::InvalidInput(
            "template workspace must be a checked-out Git repository".into(),
        ));
    }
    let digest: Sha256Digest = input.plugin_digest.parse().map_err(|_| {
        SproutError::InvalidInput("pluginDigest must be a lowercase SHA-256 digest".into())
    })?;
    let provenance = ArtifactProvenance::deployment_templates(input.deployment_templates_commit);
    let target = PluginTarget::current()?;
    let temporary = tempfile::tempdir().map_err(|source| SproutError::Io {
        operation: "create verified plugin directory",
        source,
    })?;
    let executable_path = temporary.path().join(target.executable_name());
    let verifier = CosignProvenanceVerifier::detect()?;
    let downloader = OciDownloader::new(verifier, ArtifactLimits::default());
    let executable = downloader
        .download_verified(
            &input.plugin_reference,
            &digest,
            target,
            &provenance,
            &RegistryAuth::Anonymous,
            &executable_path,
        )
        .await?;
    let isolation = NativeIsolationProvider::detect()?;
    let result = PluginRunner::new(isolation, ApplyLimits::default())
        .apply(&executable, workspace, &CanonicalProtocol, &input.request)
        .await?;
    serde_json::to_string(&result)
        .map_err(|error| SproutError::ProtocolViolation(error.to_string()))
}

fn validate(input: &ApplyTemplateInput) -> sprout_core::Result<()> {
    if input.request.workspace != "/workspace" {
        return Err(SproutError::InvalidInput(
            "request.workspace must be /workspace, the isolated plugin mount".into(),
        ));
    }
    if input.request.template.plugin_digest != input.plugin_digest {
        return Err(SproutError::InvalidInput(
            "request template digest does not match pluginDigest".into(),
        ));
    }
    if !input
        .deployment_templates_commit
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || input.deployment_templates_commit.len() != 40
    {
        return Err(SproutError::InvalidInput(
            "deploymentTemplatesCommit must be a lowercase 40-character Git commit".into(),
        ));
    }
    Ok(())
}

fn napi_error(error: SproutError) -> Error {
    let envelope = serde_json::to_string(&error.envelope()).unwrap_or_else(|_| {
        r#"{"code":"protocol_violation","message":"could not serialize native error","retryable":false}"#.into()
    });
    Error::new(Status::GenericFailure, envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ApplyTemplateInput {
        serde_json::from_value(serde_json::json!({
            "workspacePath": "/tmp/repository",
            "pluginReference": format!("ghcr.io/mysproutos/template-umami@sha256:{}", "a".repeat(64)),
            "pluginDigest": format!("sha256:{}", "a".repeat(64)),
            "deploymentTemplatesCommit": "b".repeat(40),
            "request": {
                "protocol_version": 1,
                "workspace": "/workspace",
                "template": {
                    "id": "umami",
                    "catalogue_digest": format!("sha256:{}", "c".repeat(64)),
                    "manifest_digest": format!("sha256:{}", "d".repeat(64)),
                    "plugin_digest": format!("sha256:{}", "a".repeat(64)),
                    "upstream_repository": "https://github.com/umami-software/umami",
                    "upstream_commit": "e".repeat(40)
                },
                "deployment": {"preset": "next-standalone", "capabilities": []},
                "services": [],
                "user_inputs": [],
                "generated_inputs": []
            }
        }))
        .unwrap()
    }

    #[test]
    fn rejects_a_second_digest_or_host_workspace_before_network_access() {
        let mut digest_mismatch = input();
        digest_mismatch.request.template.plugin_digest = format!("sha256:{}", "f".repeat(64));
        assert!(
            validate(&digest_mismatch)
                .unwrap_err()
                .to_string()
                .contains("digest")
        );
        let mut host_workspace = input();
        host_workspace.request.workspace = "/tmp/repository".into();
        assert!(
            validate(&host_workspace)
                .unwrap_err()
                .to_string()
                .contains("/workspace")
        );
    }

    #[test]
    fn node_errors_preserve_the_core_error_contract() {
        let error = napi_error(SproutError::IsolationUnavailable("missing bwrap".into()));
        let envelope: serde_json::Value = serde_json::from_str(&error.reason).unwrap();
        assert_eq!(envelope["code"], "isolation_unavailable");
        assert_eq!(envelope["retryable"], false);
    }
}
