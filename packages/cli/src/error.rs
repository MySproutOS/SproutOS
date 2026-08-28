use serde::Serialize;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, CliError>;

#[derive(Debug, Error)]
pub enum CliError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("authentication required; run `sprout auth login` or set SPROUTOS_TOKEN")]
    AuthenticationRequired,
    #[error("credential store failed: {0}")]
    CredentialStore(String),
    #[error("configuration failed: {0}")]
    Configuration(String),
    #[error("authorization callback failed: {0}")]
    AuthorizationCallback(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("API request failed: {0}")]
    Api(String),
    #[error("deployment failed: {0}")]
    DeploymentFailed(String),
    #[error("operation timed out: {0}")]
    Timeout(String),
    #[error("operation is unavailable: {0}")]
    Unavailable(String),
    #[error("{message}")]
    Backend {
        code: String,
        message: String,
        retryable: bool,
    },
}

impl CliError {
    pub fn code(&self) -> String {
        match self {
            Self::InvalidInput(_) => "invalid_input".into(),
            Self::AuthenticationRequired => "authentication_required".into(),
            Self::CredentialStore(_) => "credential_store".into(),
            Self::Configuration(_) => "configuration".into(),
            Self::AuthorizationCallback(_) => "authorization_callback".into(),
            Self::Cancelled => "cancelled".into(),
            Self::Api(_) => "api".into(),
            Self::DeploymentFailed(_) => "deployment_failed".into(),
            Self::Timeout(_) => "timeout".into(),
            Self::Unavailable(_) => "unavailable".into(),
            Self::Backend { code, .. } => code.clone(),
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            Self::Backend { retryable, .. } => *retryable,
            _ => matches!(
                self,
                Self::Api(_) | Self::AuthorizationCallback(_) | Self::Timeout(_)
            ),
        }
    }

    pub fn envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            schema_version: 1,
            ok: false,
            error: ErrorBody {
                code: self.code(),
                message: self.to_string(),
                retryable: self.retryable(),
            },
        }
    }

    pub fn exit_code(&self) -> u8 {
        match self {
            Self::InvalidInput(_) => 2,
            Self::AuthenticationRequired
            | Self::CredentialStore(_)
            | Self::AuthorizationCallback(_) => 3,
            Self::Cancelled => 4,
            Self::Timeout(_) => 5,
            _ => 1,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub schema_version: u8,
    pub ok: bool,
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
