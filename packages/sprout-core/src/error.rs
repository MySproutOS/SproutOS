use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, SproutError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    ApiTransport,
    ApiResponse,
    TemplateNotFound,
    ArtifactReference,
    ArtifactDownload,
    DigestMismatch,
    ProvenanceRejected,
    ArtifactRejected,
    PackagingRejected,
    IsolationUnavailable,
    PluginSpawn,
    PluginTimeout,
    PluginOutputLimit,
    PluginFailed,
    TemplateRejected,
    ProtocolViolation,
    WorkspaceRejected,
    DiffMismatch,
    DeployTimeout,
    DeploymentFailed,
    UnknownDeploymentState,
    Io,
}

#[derive(Debug, Error)]
pub enum SproutError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("API transport failed: {0}")]
    ApiTransport(String),
    #[error("API returned status {status}: {message}")]
    ApiResponse { status: u16, message: String },
    #[error("template was not found: {0}")]
    TemplateNotFound(String),
    #[error("invalid OCI artifact reference: {0}")]
    ArtifactReference(String),
    #[error("OCI artifact download failed: {0}")]
    ArtifactDownload(String),
    #[error("artifact digest mismatch: expected {expected}, received {actual}")]
    DigestMismatch { expected: String, actual: String },
    #[error("artifact provenance was rejected: {0}")]
    ProvenanceRejected(String),
    #[error("artifact was rejected: {0}")]
    ArtifactRejected(String),
    #[error("deployment package was rejected: {0}")]
    PackagingRejected(String),
    #[error("plugin isolation is unavailable: {0}")]
    IsolationUnavailable(String),
    #[error("could not start template plugin: {0}")]
    PluginSpawn(String),
    #[error("template plugin exceeded its {timeout_ms}ms deadline")]
    PluginTimeout { timeout_ms: u64 },
    #[error("template plugin {stream} exceeded its {limit} byte output limit")]
    PluginOutputLimit { stream: &'static str, limit: usize },
    #[error("template plugin exited unsuccessfully ({status}): {stderr}")]
    PluginFailed { status: String, stderr: String },
    #[error("template plugin rejected the request ({code}): {message}")]
    TemplateRejected { code: String, message: String },
    #[error("template protocol violation: {0}")]
    ProtocolViolation(String),
    #[error("workspace entry was rejected at {path}: {reason}")]
    WorkspaceRejected { path: PathBuf, reason: String },
    #[error("template plugin reported a different diff: {0}")]
    DiffMismatch(String),
    #[error(
        "timed out after {timeout_ms}ms waiting for deployment {deployment_id}; last state was {last_state}"
    )]
    DeployTimeout {
        deployment_id: String,
        timeout_ms: u64,
        last_state: String,
    },
    #[error("deployment {deployment_id} failed in state {state}: {reason}")]
    DeploymentFailed {
        deployment_id: String,
        state: String,
        reason: String,
        migration_output: Option<String>,
    },
    #[error("deployment {deployment_id} returned unknown state {state}")]
    UnknownDeploymentState {
        deployment_id: String,
        state: String,
    },
    #[error("I/O failed during {operation}: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },
}

impl SproutError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::ApiTransport(_) => ErrorCode::ApiTransport,
            Self::ApiResponse { .. } => ErrorCode::ApiResponse,
            Self::TemplateNotFound(_) => ErrorCode::TemplateNotFound,
            Self::ArtifactReference(_) => ErrorCode::ArtifactReference,
            Self::ArtifactDownload(_) => ErrorCode::ArtifactDownload,
            Self::DigestMismatch { .. } => ErrorCode::DigestMismatch,
            Self::ProvenanceRejected(_) => ErrorCode::ProvenanceRejected,
            Self::ArtifactRejected(_) => ErrorCode::ArtifactRejected,
            Self::PackagingRejected(_) => ErrorCode::PackagingRejected,
            Self::IsolationUnavailable(_) => ErrorCode::IsolationUnavailable,
            Self::PluginSpawn(_) => ErrorCode::PluginSpawn,
            Self::PluginTimeout { .. } => ErrorCode::PluginTimeout,
            Self::PluginOutputLimit { .. } => ErrorCode::PluginOutputLimit,
            Self::PluginFailed { .. } => ErrorCode::PluginFailed,
            Self::TemplateRejected { .. } => ErrorCode::TemplateRejected,
            Self::ProtocolViolation(_) => ErrorCode::ProtocolViolation,
            Self::WorkspaceRejected { .. } => ErrorCode::WorkspaceRejected,
            Self::DiffMismatch(_) => ErrorCode::DiffMismatch,
            Self::DeployTimeout { .. } => ErrorCode::DeployTimeout,
            Self::DeploymentFailed { .. } => ErrorCode::DeploymentFailed,
            Self::UnknownDeploymentState { .. } => ErrorCode::UnknownDeploymentState,
            Self::Io { .. } => ErrorCode::Io,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::ApiTransport(_) | Self::ArtifactDownload(_))
    }

    pub fn envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            code: self.code(),
            message: self.to_string(),
            retryable: self.retryable(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}
