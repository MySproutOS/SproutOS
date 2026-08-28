//! Shared, UI-agnostic implementation for SproutOS deployment clients.

mod api;
mod deploy;
mod digest;
mod error;
mod isolation;
mod oci;
mod package;
mod plugin;
mod provenance;
mod resolve;
mod workspace;

pub use api::{ApiClient, ApiClientConfig, ApiResponse};
pub use deploy::{
    DeployArtifactInput, DeployEvent, DeployHttpApi, DeployObserver, DeployRequest, DeployResult,
    Deployer, DeploymentApi, DeploymentState, DeploymentStatus, PollConfig, QueuedDeployment,
    ReleaseRequest, UploadRequest, UploadTarget,
};
pub use digest::Sha256Digest;
pub use error::{ErrorCode, ErrorEnvelope, Result, SproutError};
pub use isolation::NativeIsolationProvider;
pub use oci::{
    ArtifactLimits, ArtifactProvenance, OciDownloader, PLUGIN_EXECUTABLE_MEDIA_TYPE,
    PLUGIN_INDEX_ARTIFACT_TYPE, PLUGIN_MANIFEST_ARTIFACT_TYPE, PluginTarget, ProvenanceVerifier,
    VerifiedExecutable,
};
pub use package::{ArtifactPackager, PackageKind, PackagedArtifact, PackagingLimits, StaticPath};
pub use plugin::{
    ApplyLimits, ApplyResult, CanonicalProtocol, IsolatedCommand, IsolationProvider, PluginRunner,
    ProtocolOutcome, TemplateProtocol,
};
pub use provenance::CosignProvenanceVerifier;
pub use resolve::{CatalogueResolver, ResolvedTemplate, TemplateSelector};
pub use workspace::{ChangeKind, DeclaredChange, DiffLimits, WorkspaceChange};
