//! Presentation, authentication, and operating-system integration for the `sprout` CLI.
//!
//! Deployment, packaging, API transport, and template execution belong to `sprout-core`. This
//! crate deliberately keeps those mechanics behind [`Backend`] so the CLI and the ECS worker do
//! not grow two implementations of the same protocol.

pub mod app;
pub mod auth;
pub mod cli;
pub mod config;
pub mod confirm;
pub mod core_backend;
pub mod credential;
pub mod error;
pub mod output;
pub mod request;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use error::{CliError, ErrorEnvelope, Result};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub timestamp: String,
    pub cursor: String,
    pub level: String,
    pub message: String,
    pub request_id: String,
    pub deployment_id: String,
    pub duration_ms: Option<f64>,
    pub billed_ms: Option<u32>,
    pub memory_mb: Option<u32>,
    pub init_ms: Option<f64>,
    pub cold_start: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamEvent {
    pub schema_version: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub cursor: String,
    pub line: LogLine,
}

/// Destination for already-rendered streaming records. Implementations must flush each line.
pub trait StreamOutput: Send + Sync {
    fn write_line(&self, line: &str) -> Result<()>;
}

/// The narrow UI-to-core seam. A production implementation delegates to `sprout-core`.
#[async_trait]
pub trait Backend: Send + Sync {
    async fn request(&self, request: request::ApiRequest, token: Option<&str>) -> Result<Value>;

    async fn deploy(
        &self,
        _args: &cli::DeployArgs,
        _token: &str,
        _organization: Option<&str>,
        _repository_bound_token: bool,
    ) -> Result<Value> {
        Err(CliError::Unavailable(
            "this build has no sprout-core deploy adapter".into(),
        ))
    }

    async fn template(&self, _command: &cli::TemplateCommand, _token: &str) -> Result<Value> {
        Err(CliError::Unavailable(
            "this build has no sprout-core template adapter".into(),
        ))
    }

    async fn follow_logs(
        &self,
        _request: request::ApiRequest,
        _token: &str,
        _emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send),
    ) -> Result<()> {
        Err(CliError::Unavailable(
            "this build has no streaming log adapter".into(),
        ))
    }
}
