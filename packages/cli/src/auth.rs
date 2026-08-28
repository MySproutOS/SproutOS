use std::{collections::HashMap, io, time::Duration};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
use url::Url;
use zeroize::Zeroize;

use crate::{
    Backend, CliError, Result,
    credential::CredentialStore,
    request::{ApiRequest, Method},
};

pub const CLI_CLIENT_ID: &str = "01a03b00-0000-7000-8000-0000000c1101";
pub const CALLBACK_PATH: &str = "/oauth/callback";
const MAX_CALLBACK_BYTES: usize = 16 * 1024;

/// Exact permissions requested by the first-party CLI. The server intersects them with the
/// user's live RBAC on every request and binds the resulting key to one organization.
pub const CLI_SCOPES: &[&str] = &[
    "org:read",
    "credential:write",
    "project:read",
    "project:create",
    "project:update",
    "project:delete",
    "deployment:read",
    "deployment:write",
    "database:read",
    "database:create",
    "database:delete",
    "observability:logs:read",
];

pub trait BrowserLauncher: Send + Sync {
    fn open(&self, url: &Url) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemBrowser;

impl BrowserLauncher for SystemBrowser {
    fn open(&self, url: &Url) -> Result<()> {
        webbrowser::open(url.as_str()).map(|_| ()).map_err(|error| {
            CliError::AuthorizationCallback(format!("could not open a browser: {error}"))
        })
    }
}

/// PKCE material is intentionally not Debug or Serialize.
pub struct PkceAttempt {
    state: String,
    verifier: String,
    challenge: String,
}

impl Drop for PkceAttempt {
    fn drop(&mut self) {
        self.state.zeroize();
        self.verifier.zeroize();
        self.challenge.zeroize();
    }
}

impl PkceAttempt {
    pub fn generate(rng: &mut (impl RngCore + CryptoRng)) -> Self {
        let mut verifier = [0_u8; 32];
        let mut state = [0_u8; 32];
        rng.fill_bytes(&mut verifier);
        rng.fill_bytes(&mut state);
        let verifier = URL_SAFE_NO_PAD.encode(verifier);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            state: URL_SAFE_NO_PAD.encode(state),
            verifier,
            challenge,
        }
    }

    pub fn authorization_url(
        &self,
        website_url: &Url,
        redirect_uri: &Url,
        scopes: &[&str],
    ) -> Result<Url> {
        let mut url = website_url.join("/oauth/authorize").map_err(|error| {
            CliError::InvalidInput(format!("invalid website authorization URL: {error}"))
        })?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLI_CLIENT_ID)
            .append_pair("redirect_uri", redirect_uri.as_str())
            .append_pair("scope", &scopes.join(" "))
            .append_pair("state", &self.state)
            .append_pair("code_challenge", &self.challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(url)
    }

    pub fn exchange_request(&self, code: String, redirect_uri: &Url) -> CliTokenExchangeRequest {
        CliTokenExchangeRequest {
            code,
            client_id: CLI_CLIENT_ID.into(),
            redirect_uri: redirect_uri.as_str().into(),
            code_verifier: self.verifier.clone(),
        }
    }

    fn validate_state(&self, received: &str) -> Result<()> {
        if received == self.state {
            Ok(())
        } else {
            Err(CliError::AuthorizationCallback(
                "the callback state did not match the login attempt".into(),
            ))
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTokenExchangeRequest {
    pub code: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_verifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTokenExchangeResponse {
    pub key: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<String>,
    pub organization: AuthorizedOrganization,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuthorizedOrganization {
    pub id: String,
    pub slug: String,
}

impl std::fmt::Debug for CliTokenExchangeResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CliTokenExchangeResponse")
            .field("key", &"[REDACTED]")
            .field("scopes", &self.scopes)
            .field("expires_at", &self.expires_at)
            .field("organization", &self.organization)
            .finish()
    }
}

impl Drop for CliTokenExchangeResponse {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

pub struct CallbackListener {
    listener: TcpListener,
    redirect_uri: Url,
}

impl CallbackListener {
    pub async fn bind() -> Result<Self> {
        // Literal IPv4 loopback, never localhost (which may resolve elsewhere) and never 0.0.0.0.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| CliError::AuthorizationCallback(error.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|error| CliError::AuthorizationCallback(error.to_string()))?
            .port();
        let redirect_uri = Url::parse(&format!("http://127.0.0.1:{port}{CALLBACK_PATH}"))
            .expect("a loopback URL with a u16 port is valid");
        Ok(Self {
            listener,
            redirect_uri,
        })
    }

    pub fn redirect_uri(&self) -> &Url {
        &self.redirect_uri
    }

    pub async fn receive(self, attempt: &PkceAttempt, deadline: Duration) -> Result<String> {
        timeout(deadline, self.receive_inner(attempt))
            .await
            .map_err(|_| {
                CliError::AuthorizationCallback("timed out waiting for the browser".into())
            })?
    }

    async fn receive_inner(self, attempt: &PkceAttempt) -> Result<String> {
        let (mut stream, peer) = self
            .listener
            .accept()
            .await
            .map_err(|error| CliError::AuthorizationCallback(error.to_string()))?;
        if !peer.ip().is_loopback() {
            return Err(CliError::AuthorizationCallback(
                "refused a callback that did not come from loopback".into(),
            ));
        }
        let mut bytes = Vec::with_capacity(2048);
        loop {
            let mut chunk = [0_u8; 1024];
            let count = stream
                .read(&mut chunk)
                .await
                .map_err(|error| CliError::AuthorizationCallback(error.to_string()))?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if bytes.len() > MAX_CALLBACK_BYTES {
                return Err(CliError::AuthorizationCallback(
                    "callback request was too large".into(),
                ));
            }
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }

        let result = parse_callback(&bytes, attempt);
        let (status, message) = if result.is_ok() {
            (
                "200 OK",
                "SproutOS login completed. You may close this window.",
            )
        } else {
            (
                "400 Bad Request",
                "SproutOS login was refused. Return to the terminal for details.",
            )
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
            message.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        result
    }
}

fn parse_callback(bytes: &[u8], attempt: &PkceAttempt) -> Result<String> {
    let request = std::str::from_utf8(bytes)
        .map_err(|_| CliError::AuthorizationCallback("callback was not UTF-8".into()))?;
    let line = request
        .lines()
        .next()
        .ok_or_else(|| CliError::AuthorizationCallback("callback request was empty".into()))?;
    let mut parts = line.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(CliError::AuthorizationCallback(
            "callback must use GET".into(),
        ));
    }
    let target = parts
        .next()
        .ok_or_else(|| CliError::AuthorizationCallback("callback target was missing".into()))?;
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| CliError::AuthorizationCallback("callback target was malformed".into()))?;
    if url.path() != CALLBACK_PATH {
        return Err(CliError::AuthorizationCallback(
            "callback path did not match".into(),
        ));
    }
    let mut values = HashMap::new();
    for (key, value) in url.query_pairs() {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(CliError::AuthorizationCallback(
                "callback contained a duplicate parameter".into(),
            ));
        }
    }
    if let Some(error) = values.get("error") {
        let safe_error: String = error
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .take(80)
            .collect();
        return Err(CliError::AuthorizationCallback(format!(
            "authorization server returned {}",
            if safe_error.is_empty() {
                "an error"
            } else {
                &safe_error
            }
        )));
    }
    let state = values
        .get("state")
        .ok_or_else(|| CliError::AuthorizationCallback("callback state was missing".into()))?;
    attempt.validate_state(state)?;
    values
        .get("code")
        .filter(|code| !code.is_empty())
        .cloned()
        .ok_or_else(|| CliError::AuthorizationCallback("authorization code was missing".into()))
}

/// Save only the long-lived scoped API key. Access tokens, refresh tokens, authorization codes,
/// state, and the PKCE verifier never enter the credential store.
pub fn save_exchange(
    store: &dyn CredentialStore,
    account: &str,
    mut response: CliTokenExchangeResponse,
) -> Result<AuthorizedOrganization> {
    if response.key.is_empty() {
        return Err(CliError::AuthorizationCallback(
            "server returned an empty API key".into(),
        ));
    }
    store.set(account, &response.key)?;
    Ok(std::mem::replace(
        &mut response.organization,
        AuthorizedOrganization {
            id: String::new(),
            slug: String::new(),
        },
    ))
}

pub struct LoginOptions<'a> {
    pub account: &'a str,
    pub website_url: &'a Url,
    pub open_browser: bool,
    pub deadline: Duration,
    pub show_url: &'a dyn Fn(&Url),
}

pub async fn login(
    backend: &dyn Backend,
    store: &dyn CredentialStore,
    browser: &dyn BrowserLauncher,
    options: LoginOptions<'_>,
) -> Result<AuthorizedOrganization> {
    let listener = CallbackListener::bind().await?;
    let attempt = PkceAttempt::generate(&mut rand::rngs::OsRng);
    let authorization_url =
        attempt.authorization_url(options.website_url, listener.redirect_uri(), CLI_SCOPES)?;
    if !options.open_browser || browser.open(&authorization_url).is_err() {
        // Browser launching is convenience, not authority. Manual opening retains state + PKCE.
        (options.show_url)(&authorization_url);
    }

    let redirect_uri = listener.redirect_uri().clone();
    let code = listener.receive(&attempt, options.deadline).await?;
    let body = serde_json::to_value(attempt.exchange_request(code, &redirect_uri))
        .map_err(|error| CliError::AuthorizationCallback(error.to_string()))?;
    let response = backend
        .request(
            ApiRequest {
                method: Method::Post,
                path: "/v1/auth/cli/token".into(),
                body: Some(body),
            },
            None,
        )
        .await?;
    let response: CliTokenExchangeResponse = serde_json::from_value(response).map_err(|error| {
        CliError::AuthorizationCallback(format!("invalid token response: {error}"))
    })?;
    save_exchange(store, options.account, response)
}

pub fn io_error(error: io::Error) -> CliError {
    CliError::AuthorizationCallback(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    #[test]
    fn pkce_is_s256_base64url_without_padding() {
        let attempt = PkceAttempt::generate(&mut StdRng::seed_from_u64(7));
        assert!(!attempt.verifier.contains('='));
        assert!(!attempt.challenge.contains('='));
        assert_eq!(
            attempt.challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes()))
        );
    }

    #[test]
    fn authorization_url_contains_standard_pkce_parameters() {
        let attempt = PkceAttempt::generate(&mut StdRng::seed_from_u64(8));
        let redirect = Url::parse("http://127.0.0.1:43123/oauth/callback").unwrap();
        let url = attempt
            .authorization_url(
                &Url::parse("https://sprout.example").unwrap(),
                &redirect,
                &["project:read", "deployment:write"],
            )
            .unwrap();
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(query["client_id"], CLI_CLIENT_ID);
        assert_eq!(query["redirect_uri"], redirect.as_str());
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["scope"], "project:read deployment:write");
    }

    #[test]
    fn callback_rejects_state_mismatch_and_error_without_leaking_values() {
        let attempt = PkceAttempt::generate(&mut StdRng::seed_from_u64(9));
        let wrong = b"GET /oauth/callback?code=canary-code&state=wrong HTTP/1.1\r\n\r\n";
        assert!(
            parse_callback(wrong, &attempt)
                .unwrap_err()
                .to_string()
                .contains("state")
        );
        let denied = format!(
            "GET /oauth/callback?error=access_denied&state={} HTTP/1.1\r\n\r\n",
            attempt.state
        );
        let rendered = parse_callback(denied.as_bytes(), &attempt)
            .unwrap_err()
            .to_string();
        assert!(rendered.contains("access_denied"));
        assert!(!rendered.contains(&attempt.state));
    }

    #[tokio::test]
    async fn callback_listener_binds_literal_ephemeral_loopback() {
        let listener = CallbackListener::bind().await.unwrap();
        assert_eq!(listener.redirect_uri().host_str(), Some("127.0.0.1"));
        assert_ne!(listener.redirect_uri().port(), Some(0));
        assert_eq!(listener.redirect_uri().path(), CALLBACK_PATH);
    }
}
