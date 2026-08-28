use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{ArtifactProvenance, PluginTarget, Result, Sha256Digest};

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
}

#[async_trait]
pub trait CatalogueResolver: Send + Sync {
    async fn resolve(&self, selector: &TemplateSelector) -> Result<ResolvedTemplate>;
}
