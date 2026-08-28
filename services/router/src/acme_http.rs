//! Opt-in port-80 edge for HTTP-01 validation and HTTPS redirects.

use std::sync::Arc;

use anyhow::Context as _;
use async_trait::async_trait;
use axum::Router as AxumRouter;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use redis::AsyncCommands as _;
use redis::aio::ConnectionManager;

const CHALLENGE_PREFIX: &str = "/.well-known/acme-challenge/";

pub fn challenge_key(host: &str, token: &str) -> String {
    format!("acme:http-01:{host}:{token}")
}

#[async_trait]
pub trait Http01Store: Send + Sync {
    async fn challenge(&self, host: &str, token: &str) -> anyhow::Result<Option<String>>;
    async fn route_is_active(&self, host: &str) -> anyhow::Result<bool>;
    async fn domain_is_pending(&self, host: &str) -> anyhow::Result<bool>;
}

#[async_trait]
impl Http01Store for ConnectionManager {
    async fn challenge(&self, host: &str, token: &str) -> anyhow::Result<Option<String>> {
        let mut connection = self.clone();
        Ok(connection.get(challenge_key(host, token)).await?)
    }

    async fn route_is_active(&self, host: &str) -> anyhow::Result<bool> {
        let mut connection = self.clone();
        let raw: Option<String> = connection.get(crate::route::route_key(host)).await?;
        Ok(raw.as_deref().and_then(crate::route::parse_route).is_some())
    }

    async fn domain_is_pending(&self, host: &str) -> anyhow::Result<bool> {
        let mut connection = self.clone();
        Ok(connection
            .exists(format!("custom-domain:pending:{host}"))
            .await?)
    }
}

pub fn app(store: Arc<dyn Http01Store>) -> AxumRouter {
    AxumRouter::new().fallback(handle).with_state(store)
}

async fn handle(
    State(store): State<Arc<dyn Http01Store>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(normalize_dns_host)
    else {
        return (StatusCode::BAD_REQUEST, "a valid Host header is required").into_response();
    };

    if let Some(token) = uri.path().strip_prefix(CHALLENGE_PREFIX) {
        if method != Method::GET {
            return StatusCode::METHOD_NOT_ALLOWED.into_response();
        }
        if !valid_token(token) {
            return StatusCode::NOT_FOUND.into_response();
        }
        return match store.challenge(&host, token).await {
            Ok(Some(authorization)) => (StatusCode::OK, authorization).into_response(),
            Ok(None) => StatusCode::NOT_FOUND.into_response(),
            Err(cause) => {
                tracing::error!(%cause, %host, "HTTP-01 challenge lookup failed");
                StatusCode::SERVICE_UNAVAILABLE.into_response()
            }
        };
    }

    match store.route_is_active(&host).await {
        Ok(true) => {
            let location = format!(
                "https://{host}{}",
                uri.path_and_query().map_or("/", |value| value.as_str())
            );
            (
                StatusCode::PERMANENT_REDIRECT,
                [(header::LOCATION, location)],
            )
                .into_response()
        }
        Ok(false) => match store.domain_is_pending(&host).await {
            Ok(true) => (
                StatusCode::TOO_EARLY,
                "This domain is still being configured.",
            )
                .into_response(),
            Ok(false) => StatusCode::NOT_FOUND.into_response(),
            Err(cause) => {
                tracing::error!(%cause, %host, "HTTP pending-domain lookup failed");
                StatusCode::SERVICE_UNAVAILABLE.into_response()
            }
        },
        Err(cause) => {
            tracing::error!(%cause, %host, "HTTP route lookup failed");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 256
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalize_dns_host(host: &str) -> Option<String> {
    let host = host
        .trim()
        .split_once(':')
        .filter(|(_, port)| port.parse::<u16>().is_ok())
        .map_or(host.trim(), |(name, _)| name)
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    valid.then_some(host)
}

/// Start port 80 only when explicitly configured. It is independent of the TLS edge so an ACME
/// validation can run before any certificate exists.
pub async fn start_from_env(
    valkey: ConnectionManager,
    readiness: Arc<crate::edge_readiness::EdgeReadiness>,
) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let listen = match std::env::var("ROUTER_HTTP_EDGE_LISTEN") {
        Ok(listen) => listen,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(cause) => return Err(cause).context("ROUTER_HTTP_EDGE_LISTEN is not valid Unicode"),
    };
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for the HTTP edge"))?;
    let app = app(Arc::new(valkey));
    let proxy_protocol = crate::proxy_protocol::required_from_env()?;
    let ready = readiness.http_guard();
    tracing::info!(%listen, "opt-in HTTP edge listening");
    Ok(Some(tokio::spawn(async move {
        let _ready = ready;
        if let Err(cause) = axum::serve(
            crate::proxy_protocol::ProxyProtocolListener::new(listener, proxy_protocol),
            app,
        )
        .await
        {
            tracing::error!(%cause, "HTTP edge stopped serving");
        }
    })))
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt as _;

    use super::*;

    struct MemoryStore {
        challenges: HashMap<String, String>,
        active: HashSet<String>,
        pending: HashSet<String>,
    }

    #[async_trait]
    impl Http01Store for MemoryStore {
        async fn challenge(&self, host: &str, token: &str) -> anyhow::Result<Option<String>> {
            Ok(self.challenges.get(&challenge_key(host, token)).cloned())
        }

        async fn route_is_active(&self, host: &str) -> anyhow::Result<bool> {
            Ok(self.active.contains(host))
        }

        async fn domain_is_pending(&self, host: &str) -> anyhow::Result<bool> {
            Ok(self.pending.contains(host))
        }
    }

    fn store() -> Arc<dyn Http01Store> {
        Arc::new(MemoryStore {
            challenges: HashMap::from([(
                challenge_key("app.example.test", "valid_token"),
                "valid_token.thumbprint".into(),
            )]),
            active: HashSet::from(["app.example.test".into()]),
            pending: HashSet::from(["pending.example.test".into()]),
        })
    }

    #[tokio::test]
    async fn challenge_is_read_from_the_host_and_token_scoped_key() {
        let response = app(store())
            .oneshot(
                Request::get("/.well-known/acme-challenge/valid_token")
                    .header("host", "APP.EXAMPLE.TEST:80")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "valid_token.thumbprint"
        );
    }

    #[tokio::test]
    async fn active_routes_redirect_but_pending_domains_explain_their_state() {
        let active = app(store())
            .oneshot(
                Request::get("/posts?page=2")
                    .header("host", "app.example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(active.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            active.headers()[header::LOCATION],
            "https://app.example.test/posts?page=2"
        );

        let pending = app(store())
            .oneshot(
                Request::get("/")
                    .header("host", "pending.example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::TOO_EARLY);

        let unknown = app(store())
            .oneshot(
                Request::get("/")
                    .header("host", "unknown.example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn malformed_tokens_never_become_valkey_key_material() {
        let response = app(store())
            .oneshot(
                Request::get("/.well-known/acme-challenge/not/one/token")
                    .header("host", "app.example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
