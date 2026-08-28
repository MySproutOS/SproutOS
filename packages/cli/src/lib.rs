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
use serde_json::Value;

pub use error::{CliError, ErrorEnvelope, Result};

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
}
