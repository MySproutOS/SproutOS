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
    #[error("operation is unavailable: {0}")]
    Unavailable(String),
}

impl CliError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalid_input",
            Self::AuthenticationRequired => "authentication_required",
            Self::CredentialStore(_) => "credential_store",
            Self::Configuration(_) => "configuration",
            Self::AuthorizationCallback(_) => "authorization_callback",
            Self::Cancelled => "cancelled",
            Self::Api(_) => "api",
            Self::Unavailable(_) => "unavailable",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::Api(_) | Self::AuthorizationCallback(_))
    }

    pub fn envelope(&self) -> ErrorEnvelope<'_> {
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
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope<'a> {
    pub schema_version: u8,
    pub ok: bool,
    pub error: ErrorBody<'a>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody<'a> {
    pub code: &'a str,
    pub message: String,
    pub retryable: bool,
}
