//! OAuth plumbing for the Android Developer Console API.
//!
//! Google currently documents the OAuth Web Server flow and registration method names, but not
//! the Console API's REST mutation schemas. This module deliberately stops at acquiring a scoped
//! access token; callers must not guess the unpublished registration payloads.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use base64::Engine as _;
use rand::RngCore as _;
use reqwest::StatusCode;
use serde::Deserialize;
use zeroize::Zeroizing;

pub const SCOPE: &str = "https://www.googleapis.com/auth/androiddeveloperconsole";
pub const AUTHORIZATION_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

#[derive(Clone)]
pub struct DeveloperConsoleOAuth {
    client: reqwest::Client,
    client_id: String,
    client_secret: Zeroizing<String>,
    refresh_token_path: PathBuf,
    token_endpoint: String,
}

pub struct AccessToken {
    value: Zeroizing<String>,
    expires_at: Instant,
}

impl AccessToken {
    pub fn bearer(&self) -> &str {
        &self.value
    }

    pub fn expires_at(&self) -> Instant {
        self.expires_at
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    token_type: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: Option<String>,
}

impl DeveloperConsoleOAuth {
    pub fn new(
        client_id: String,
        client_secret: String,
        refresh_token_path: PathBuf,
    ) -> anyhow::Result<Self> {
        Self::with_token_endpoint(client_id, client_secret, refresh_token_path, TOKEN_ENDPOINT)
    }

    fn with_token_endpoint(
        client_id: String,
        client_secret: String,
        refresh_token_path: PathBuf,
        token_endpoint: impl Into<String>,
    ) -> anyhow::Result<Self> {
        if client_id.is_empty() || client_secret.is_empty() {
            bail!("Android Developer Console OAuth client credentials must not be empty")
        }
        assert_private_permissions(&refresh_token_path)?;
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            client_id,
            client_secret: Zeroizing::new(client_secret),
            refresh_token_path,
            token_endpoint: token_endpoint.into(),
        })
    }

    pub async fn access_token(&self) -> anyhow::Result<AccessToken> {
        let encoded = Zeroizing::new(
            std::fs::read_to_string(&self.refresh_token_path)
                .context("could not read the Android Developer Console refresh token")?,
        );
        let refresh_token = Zeroizing::new(encoded.trim().to_owned());
        if refresh_token.is_empty() {
            bail!("the Android Developer Console refresh token file is empty")
        }
        let response = self
            .client
            .post(&self.token_endpoint)
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("refresh_token", refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .context("could not reach the Google OAuth token endpoint")?;
        if !response.status().is_success() {
            let status = response.status();
            let error = response
                .json::<OAuthError>()
                .await
                .unwrap_or(OAuthError { error: None });
            if error.error.as_deref() == Some("invalid_grant") {
                bail!("Android Developer Console authorization expired; repeat one-time consent")
            }
            bail!("Google OAuth token refresh was refused with {status}")
        }
        let token: TokenResponse = response
            .json()
            .await
            .context("Google OAuth returned a malformed token response")?;
        if token.token_type != "Bearer" || token.access_token.is_empty() || token.expires_in == 0 {
            bail!("Google OAuth returned an unusable access token")
        }
        Ok(AccessToken {
            value: Zeroizing::new(token.access_token),
            expires_at: Instant::now() + Duration::from_secs(token.expires_in),
        })
    }
}

pub fn authorization_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
) -> anyhow::Result<String> {
    if client_id.is_empty() || state.len() < 32 {
        bail!("OAuth client id is empty or CSRF state is too short")
    }
    let redirect = url::Url::parse(redirect_uri).context("OAuth redirect URI is malformed")?;
    if redirect.scheme() != "http"
        || !is_loopback(&redirect)
        || !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.query().is_some()
        || redirect.fragment().is_some()
    {
        bail!("the signer consent receiver must use a loopback HTTP redirect URI")
    }
    let mut url = url::Url::parse(AUTHORIZATION_ENDPOINT).expect("constant authorization URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect.as_str())
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true")
        .append_pair("state", state);
    Ok(url.into())
}

pub async fn receive_consent_and_store_refresh_token(
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    output: PathBuf,
) -> anyhow::Result<String> {
    let client_secret = Zeroizing::new(client_secret);
    let redirect = url::Url::parse(&redirect_uri).context("OAuth redirect URI is malformed")?;
    if redirect.scheme() != "http" || !is_loopback(&redirect) {
        bail!("OAuth consent redirect must be a loopback HTTP URL")
    }
    let host = redirect.host_str().context("OAuth redirect has no host")?;
    let port = redirect
        .port()
        .context("OAuth loopback redirect must use an explicit port")?;
    let expected_path = redirect.path().to_owned();
    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .context("could not bind the OAuth loopback receiver")?;

    let mut state_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut state_bytes);
    let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(state_bytes);
    let authorization_url = authorization_url(&client_id, &redirect_uri, &state)?;
    println!(
        "Open this URL with the Google account that owns or administers the existing verified Play Console account to authorize Android Developer Console API access:\n{authorization_url}"
    );

    let (mut stream, peer) = tokio::time::timeout(Duration::from_secs(10 * 60), listener.accept())
        .await
        .context("timed out waiting for Android Developer Console consent")??;
    if !peer.ip().is_loopback() {
        bail!("OAuth callback did not originate from the loopback interface")
    }
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut request = Vec::with_capacity(2048);
    loop {
        let mut chunk = [0_u8; 2048];
        let size = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk))
            .await
            .context("timed out reading the OAuth callback")??;
        if size == 0 {
            bail!("OAuth callback ended before its HTTP headers")
        }
        request.extend_from_slice(&chunk[..size]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() >= 16 * 1024 {
            bail!("OAuth callback headers exceed the size limit")
        }
    }
    let request = std::str::from_utf8(&request).context("OAuth callback was not HTTP text")?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.strip_suffix(" HTTP/1.1"))
        .context("OAuth callback request line was malformed")?;
    let callback = url::Url::parse(&format!("http://localhost{target}"))
        .context("OAuth callback URL was malformed")?;
    if callback.path() != expected_path {
        bail!("OAuth callback used the wrong path")
    }
    let parameter = |name: &str| {
        callback
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if parameter("state").as_deref() != Some(&state) {
        bail!("OAuth callback state did not match")
    }
    let code = Zeroizing::new(parameter("code").context("OAuth callback did not contain a code")?);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .context("could not exchange the Android Developer Console authorization code")?;
    #[derive(Deserialize)]
    struct ExchangeResponse {
        refresh_token: Option<String>,
    }
    if response.status() != StatusCode::OK {
        bail!("Google OAuth authorization-code exchange was refused")
    }
    let mut exchange: ExchangeResponse = response
        .json()
        .await
        .context("Google OAuth returned a malformed code-exchange response")?;
    let refresh_token = Zeroizing::new(exchange.refresh_token.take().context(
        "Google did not return a refresh token; revoke prior consent and retry with prompt=consent",
    )?);
    write_secret(&output, refresh_token.as_bytes())?;

    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nAndroid Developer Console authorization saved. You may close this window.\n")
        .await?;
    Ok(authorization_url)
}

fn is_loopback(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

fn write_secret(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("refresh token path has no parent")?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .context("refusing to overwrite an existing refresh token")?;
        use std::io::Write as _;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .context("refusing to overwrite an existing refresh token")?;
        use std::io::Write as _;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    Ok(())
}

fn assert_private_permissions(path: &Path) -> anyhow::Result<()> {
    if !path.is_file() {
        bail!("Android Developer Console refresh token file does not exist")
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if std::fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            bail!("Android Developer Console refresh token must not be group/world accessible")
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{Form, Json, Router, routing::post};
    use serde_json::json;

    use super::*;

    #[test]
    fn authorization_url_has_the_documented_offline_scope_and_csrf_state() {
        let url = authorization_url(
            "client-id",
            "http://127.0.0.1:8787/oauth/callback",
            &"state".repeat(8),
        )
        .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(pairs["scope"], SCOPE);
        assert_eq!(pairs["access_type"], "offline");
        assert_eq!(pairs["prompt"], "consent");
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(pairs["state"], "statestatestatestatestatestatestatestate");
    }

    #[tokio::test]
    async fn refreshes_without_exposing_the_stored_refresh_token() {
        let received = Arc::new(Mutex::new(None));
        let capture = Arc::clone(&received);
        let app = Router::new().route(
            "/token",
            post(
                move |Form(form): Form<std::collections::HashMap<String, String>>| {
                    let capture = Arc::clone(&capture);
                    async move {
                        *capture.lock().unwrap() = Some(form);
                        Json(json!({
                            "access_token": "short-lived-access",
                            "expires_in": 3600,
                            "token_type": "Bearer"
                        }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = tempfile::tempdir().unwrap();
        let token_path = temp.path().join("refresh-token");
        write_secret(&token_path, b"long-lived-refresh").unwrap();
        let oauth = DeveloperConsoleOAuth::with_token_endpoint(
            "client".into(),
            "secret".into(),
            token_path,
            format!("http://{address}/token"),
        )
        .unwrap();

        let token = oauth.access_token().await.unwrap();
        server.abort();
        assert_eq!(token.bearer(), "short-lived-access");
        let form = received.lock().unwrap();
        let form = form.as_ref().unwrap();
        assert_eq!(form["refresh_token"], "long-lived-refresh");
        assert_eq!(form["grant_type"], "refresh_token");
    }

    #[tokio::test]
    async fn invalid_grant_requests_reconsent_without_echoing_credentials() {
        let app = Router::new().route(
            "/token",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "invalid_grant" })),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let temp = tempfile::tempdir().unwrap();
        let token_path = temp.path().join("refresh-token");
        write_secret(&token_path, b"never-echo-this-refresh-token").unwrap();
        let oauth = DeveloperConsoleOAuth::with_token_endpoint(
            "client".into(),
            "never-echo-this-client-secret".into(),
            token_path,
            format!("http://{address}/token"),
        )
        .unwrap();

        let error = match oauth.access_token().await {
            Ok(_) => panic!("invalid grant unexpectedly produced an access token"),
            Err(error) => error.to_string(),
        };
        server.abort();
        assert!(error.contains("repeat one-time consent"));
        assert!(!error.contains("never-echo"));
    }

    #[cfg(unix)]
    #[test]
    fn refresh_token_is_created_private_and_never_overwritten() {
        use std::os::unix::fs::PermissionsExt as _;

        let temp = tempfile::tempdir().unwrap();
        let token_path = temp.path().join("refresh-token");
        write_secret(&token_path, b"first").unwrap();
        assert_eq!(
            std::fs::metadata(&token_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(write_secret(&token_path, b"second").is_err());
        assert_eq!(std::fs::read(&token_path).unwrap(), b"first");
    }
}
