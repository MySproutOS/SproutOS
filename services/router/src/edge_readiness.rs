//! Dedicated readiness for the two public tenant-edge wire paths.
//!
//! The ordinary router `/healthz` proves the process and durable route source booted. It cannot
//! prove that the opt-in HTTP-01 or rustls listener is still accepting. These flags are held by the
//! listener tasks themselves, and this separate Proxy-Protocol-aware port is probed by only the new
//! edge target groups.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Context as _;
use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;

#[derive(Debug, Default)]
pub struct EdgeReadiness {
    http: AtomicBool,
    tls: AtomicBool,
    tls_certificate_membership: AtomicBool,
}

impl EdgeReadiness {
    pub fn http_guard(self: &Arc<Self>) -> ReadyGuard {
        self.http.store(true, Ordering::SeqCst);
        ReadyGuard {
            state: Arc::clone(self),
            kind: Kind::Http,
        }
    }

    pub fn tls_guard(self: &Arc<Self>) -> ReadyGuard {
        self.tls.store(true, Ordering::SeqCst);
        ReadyGuard {
            state: Arc::clone(self),
            kind: Kind::Tls,
        }
    }

    pub(crate) fn set_tls_certificate_membership(&self, ready: bool) {
        self.tls_certificate_membership
            .store(ready, Ordering::SeqCst);
    }

    fn http_ready(&self) -> bool {
        self.http.load(Ordering::SeqCst)
    }

    fn tls_ready(&self) -> bool {
        self.tls.load(Ordering::SeqCst) && self.tls_certificate_membership.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy)]
enum Kind {
    Http,
    Tls,
}

pub struct ReadyGuard {
    state: Arc<EdgeReadiness>,
    kind: Kind,
}

impl Drop for ReadyGuard {
    fn drop(&mut self) {
        match self.kind {
            Kind::Http => self.state.http.store(false, Ordering::SeqCst),
            Kind::Tls => self.state.tls.store(false, Ordering::SeqCst),
        }
    }
}

fn status(ready: bool) -> StatusCode {
    if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

fn app(state: &Arc<EdgeReadiness>) -> Router {
    let http = Arc::clone(state);
    let tls = Arc::clone(state);
    Router::new()
        .route(
            "/ready/http",
            get(move || async move { status(http.http_ready()) }),
        )
        .route(
            "/ready/tls",
            get(move || async move { status(tls.tls_ready()) }),
        )
}

pub async fn start_from_env(
    state: Arc<EdgeReadiness>,
) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let listen = match std::env::var("ROUTER_EDGE_READINESS_LISTEN") {
        Ok(listen) => listen,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(cause) => {
            return Err(cause).context("ROUTER_EDGE_READINESS_LISTEN is not valid Unicode");
        }
    };
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for tenant edge readiness"))?;
    let proxy_protocol = crate::proxy_protocol::required_from_env()?;
    let app = app(&state);
    tracing::info!(%listen, "Proxy-Protocol-aware tenant edge readiness listening");
    Ok(Some(tokio::spawn(async move {
        if let Err(cause) = axum::serve(
            crate::proxy_protocol::ProxyProtocolListener::new(listener, proxy_protocol),
            app,
        )
        .await
        {
            tracing::error!(%cause, "tenant edge readiness stopped serving");
        }
    })))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;

    const PROXY_LOCAL: &[u8] = b"\r\n\r\n\0\r\nQUIT\n\x20\x00\x00\x00";

    #[test]
    fn readiness_follows_the_listener_guard_lifetime() {
        let state = Arc::new(EdgeReadiness::default());
        assert!(!state.http_ready());
        assert!(!state.tls_ready());
        let http = state.http_guard();
        let tls = state.tls_guard();
        assert!(state.http_ready());
        assert!(!state.tls_ready());
        state.set_tls_certificate_membership(true);
        assert!(state.tls_ready());
        state.set_tls_certificate_membership(false);
        assert!(!state.tls_ready());
        state.set_tls_certificate_membership(true);
        drop(http);
        assert!(!state.http_ready());
        assert!(state.tls_ready());
        drop(tls);
        assert!(!state.tls_ready());
    }

    #[tokio::test]
    async fn readiness_http_is_reached_only_after_a_proxy_prelude() {
        let state = Arc::new(EdgeReadiness::default());
        let _http = state.http_guard();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                crate::proxy_protocol::ProxyProtocolListener::new(listener, true),
                app(&state),
            )
            .await
            .unwrap();
        });

        let mut connection = tokio::net::TcpStream::connect(address).await.unwrap();
        connection.write_all(PROXY_LOCAL).await.unwrap();
        connection
            .write_all(b"GET /ready/http HTTP/1.1\r\nHost: health\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        connection.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        server.abort();
    }
}
