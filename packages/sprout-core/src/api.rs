use std::time::Duration;

use futures_util::StreamExt as _;
use reqwest::{Method, Url};
use serde::{Serialize, de::DeserializeOwned};

use crate::{Result, SproutError};

#[derive(Clone, Debug)]
pub struct ApiClientConfig {
    pub base_url: Url,
    pub token: Option<String>,
    pub timeout: Duration,
    pub max_response_bytes: usize,
}

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    config: ApiClientConfig,
}

#[derive(Clone, Debug)]
pub struct ApiResponse {
    pub status: reqwest::StatusCode,
    pub body: Vec<u8>,
}

impl ApiClient {
    pub fn new(mut config: ApiClientConfig) -> Result<Self> {
        if config.token.as_deref() == Some("") {
            return Err(SproutError::InvalidInput(
                "API token cannot be empty".into(),
            ));
        }
        if !matches!(config.base_url.scheme(), "http" | "https")
            || !config.base_url.username().is_empty()
            || config.base_url.password().is_some()
            || config.base_url.query().is_some()
            || config.base_url.fragment().is_some()
        {
            return Err(SproutError::InvalidInput(
                "API base URL must be an HTTP(S) origin/path without credentials, query, or fragment"
                    .into(),
            ));
        }
        if config.max_response_bytes == 0 {
            return Err(SproutError::InvalidInput(
                "API response limit must be greater than zero".into(),
            ));
        }
        if !config.base_url.path().ends_with('/') {
            let path = format!("{}/", config.base_url.path());
            config.base_url.set_path(&path);
        }
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| SproutError::ApiTransport(error.to_string()))?;
        Ok(Self { client, config })
    }

    pub async fn request_json<B, R>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<R>
    where
        B: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let response = self.send_json(method, path, body).await?;
        serde_json::from_slice(&response.body).map_err(|error| SproutError::ApiResponse {
            status: response.status.as_u16(),
            message: format!("invalid JSON response: {error}"),
        })
    }

    /// Send a same-origin relative API request and retain a raw/empty response body.
    pub async fn send_json<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<ApiResponse> {
        if path.starts_with('/')
            || path
                .split(['/', '?', '#'])
                .any(|component| matches!(component, "." | ".."))
        {
            return Err(SproutError::InvalidInput(
                "API paths must be normalized, relative, and must not start with '/'".into(),
            ));
        }
        let url = self
            .config
            .base_url
            .join(path)
            .map_err(|error| SproutError::InvalidInput(format!("invalid API path: {error}")))?;
        if url.origin() != self.config.base_url.origin()
            || !url.path().starts_with(self.config.base_url.path())
        {
            return Err(SproutError::InvalidInput(
                "API path must remain on the configured origin".into(),
            ));
        }
        let mut request = self.client.request(method, url);
        if let Some(token) = &self.config.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| SproutError::ApiTransport(error.to_string()))?;
        let status = response.status();
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| SproutError::ApiTransport(error.to_string()))?;
            if bytes.len().saturating_add(chunk.len()) > self.config.max_response_bytes {
                return Err(SproutError::ApiResponse {
                    status: status.as_u16(),
                    message: "response exceeded the configured size limit".into(),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|body| body.get("message")?.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "request failed".into());
            let message = self
                .config
                .token
                .as_deref()
                .filter(|token| !token.is_empty())
                .map_or(message.clone(), |token| {
                    message.replace(token, "[REDACTED]")
                });
            return Err(SproutError::ApiResponse {
                status: status.as_u16(),
                message,
            });
        }
        Ok(ApiResponse {
            status,
            body: bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::{ApiClient, ApiClientConfig};

    fn config(base_url: &str) -> ApiClientConfig {
        ApiClientConfig {
            base_url: base_url.parse().unwrap(),
            token: Some("secret".into()),
            timeout: Duration::from_secs(1),
            max_response_bytes: 1024,
        }
    }

    #[test]
    fn base_url_rejects_embedded_credentials_and_query() {
        assert!(ApiClient::new(config("https://user:password@api.example/v1")).is_err());
        assert!(ApiClient::new(config("https://api.example/v1?token=bad")).is_err());
    }

    #[tokio::test]
    async fn raw_api_path_cannot_escape_configured_base() {
        let client = ApiClient::new(config("https://api.example/internal/v1")).unwrap();
        assert!(
            client
                .send_json::<()>(reqwest::Method::GET, "../admin", None)
                .await
                .is_err()
        );
        assert!(
            client
                .send_json::<()>(reqwest::Method::GET, "https://evil.example/steal", None)
                .await
                .is_err()
        );
        assert!(
            client
                .send_json::<()>(reqwest::Method::GET, "%2e%2e/admin", None)
                .await
                .is_err()
        );
    }

    async fn server(status: &str, body: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let body = body.to_owned();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn response_errors_redact_the_configured_token() {
        let url = server(
            "400 Bad Request",
            r#"{"message":"do not echo bearer-canary-token"}"#,
        )
        .await;
        let mut settings = config(&url);
        settings.token = Some("bearer-canary-token".into());
        let error = ApiClient::new(settings)
            .unwrap()
            .send_json::<()>(reqwest::Method::GET, "v1/test", None)
            .await
            .unwrap_err();
        let envelope = serde_json::to_string(&error.envelope()).unwrap();
        assert!(!envelope.contains("bearer-canary-token"));
        assert!(envelope.contains("REDACTED"));
    }

    #[tokio::test]
    async fn response_limit_is_enforced_while_streaming() {
        let url = server("200 OK", &"x".repeat(2048)).await;
        let mut settings = config(&url);
        settings.max_response_bytes = 32;
        let error = ApiClient::new(settings)
            .unwrap()
            .send_json::<()>(reqwest::Method::GET, "v1/test", None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("size limit"));
    }
}
