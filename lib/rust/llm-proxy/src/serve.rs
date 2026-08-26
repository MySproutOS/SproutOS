//! The listener: authenticate, forward, count, bill.
//!
//! ## Why the router and not the API
//!
//! Model traffic is long-lived streaming that the customer's agent holds open for minutes. Putting
//! that on the Node control plane means an event-loop hop per chunk for every concurrent agent, on
//! the same process that holds every organization's decrypted credentials. This is the same
//! argument `AGENTS.md` makes for the other splits, and it applies here with the addition that this
//! one is the only place a model credential and a customer's traffic meet.
//!
//! ## What the sandbox sees
//!
//! `ANTHROPIC_BASE_URL` (or the OpenAI equivalent) pointing here, and a proxy token. Never a
//! provider key. That is the whole reason this exists.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt as _;

use crate::meter;
use crate::session::Session;
use crate::store::{SessionStore, StoreError};
use crate::usage::UsageAccumulator;

/// Headers that belong to *this* hop and must not be forwarded.
///
/// `host` because the upstream's virtual host is not ours; `authorization` and `x-api-key` because
/// the whole point is to replace the caller's credential with the real one; the connection headers
/// because they describe a connection that ends here. Forwarding `content-length` alongside a body
/// we may re-encode is how a proxy produces a truncated request nobody can explain.
const HOP_BY_HOP: &[&str] = &[
    "host",
    "authorization",
    "x-api-key",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

pub struct ProxyState {
    pub store: SessionStore,
    pub http: reqwest::Client,
    /// Where signed usage batches go. Absent means metering is off, which is a development
    /// configuration and is logged loudly rather than assumed.
    pub ingest_url: Option<String>,
    pub metering_key: Option<Vec<u8>>,
}

/// Handle one proxied request.
pub async fn handle(State(state): State<Arc<ProxyState>>, request: Request) -> Response {
    let Some(token) = bearer(request.headers()) else {
        return unauthorized(
            "This proxy needs a SproutOS agent token in the Authorization header.",
        );
    };

    let session = match state.store.resolve(&token).await {
        Ok(session) => session,
        Err(StoreError::NoSession) => {
            // One message for missing, expired and revoked. The log below knows which; the
            // response does not, because telling a prober which one it was tells them whether the
            // token was ever real.
            return unauthorized("That agent token is not valid. Refresh it, or start a new run.");
        }
        Err(cause) => {
            tracing::error!(%cause, "could not resolve an agent token");
            return (
                StatusCode::BAD_GATEWAY,
                "The proxy could not check that token.",
            )
                .into_response();
        }
    };

    forward(state, session, request).await
}

async fn forward(state: Arc<ProxyState>, session: Session, request: Request) -> Response {
    let (parts, body) = request.into_parts();

    let path = parts
        .uri
        .path_and_query()
        .map(|it| it.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", session.base_url.trim_end_matches('/'), path);

    let mut headers = HeaderMap::new();
    for (name, value) in &parts.headers {
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(session.upstream.auth_header().as_bytes()),
        HeaderValue::from_str(&session.upstream.auth_value(&session.secret)),
    ) {
        headers.insert(name, value);
    }

    let bytes: bytes::Bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "That request body is larger than this proxy will forward.",
            )
                .into_response();
        }
    };

    /*
      The request id, and why it is derived from the body rather than generated.

      It is the idempotency key's variable half. Generating one per attempt would mean a client
      retry after a timeout produced a second key and a second bill for one turn — which is the
      failure mode ingest's deduplication exists to prevent, defeated by the emitter.
    */
    let request_id = crate::store::hex_sha256(&format!(
        "{}:{}:{}",
        session.token_id,
        path,
        crate::store::hex_sha256(&String::from_utf8_lossy(&bytes))
    ));

    let upstream = state
        .http
        .request(parts.method.clone(), &url)
        .headers(headers)
        .body(bytes)
        .send()
        .await;

    let upstream = match upstream {
        Ok(response) => response,
        Err(cause) => {
            tracing::warn!(%cause, url = %url, "the model provider did not answer");
            return (
                StatusCode::BAD_GATEWAY,
                "The model provider did not answer.",
            )
                .into_response();
        }
    };

    let status = upstream.status();
    let mut response_headers = HeaderMap::new();
    for (name, value) in upstream.headers() {
        if HOP_BY_HOP.contains(&name.as_str()) {
            continue;
        }
        response_headers.insert(name.clone(), value.clone());
    }

    /*
      Counting happens in the stream, not after it.

      Buffering the whole response to count first would turn streaming into batch for every agent
      turn — the customer would watch nothing happen for a minute and then get everything at once.
      So the bytes pass through and the accumulator sees them on the way.
    */
    let reporter = Arc::new(UsageReporter::new(Arc::clone(&state), session, request_id));
    let for_stream = Arc::clone(&reporter);

    let stream = upstream.bytes_stream().map(move |chunk| {
        if let Ok(bytes) = &chunk {
            for_stream.observe(&String::from_utf8_lossy(bytes));
        }
        chunk
    });

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    /*
      The reporter is carried by the response's extensions so it is dropped when the response is —
      whether that is a clean end or a client that hung up. `Drop` is what makes the abandoned
      stream billable, and attaching it here rather than awaiting the stream is what makes that
      true without holding a task open per request.
    */
    response.extensions_mut().insert(reporter);
    response
}

/// Emits usage when it is dropped, however the response ended.
pub struct UsageReporter {
    state: Arc<ProxyState>,
    session: Session,
    request_id: String,
    accumulator: std::sync::Mutex<UsageAccumulator>,
}

impl UsageReporter {
    fn new(state: Arc<ProxyState>, session: Session, request_id: String) -> Self {
        Self {
            state,
            session,
            request_id,
            accumulator: std::sync::Mutex::new(UsageAccumulator::new()),
        }
    }

    fn observe(&self, chunk: &str) {
        if let Ok(mut accumulator) = self.accumulator.lock() {
            accumulator.push(chunk);
        }
    }
}

impl Drop for UsageReporter {
    fn drop(&mut self) {
        let usage = match self.accumulator.lock() {
            Ok(mut accumulator) => {
                accumulator.finish();
                accumulator.usage()
            }
            // A poisoned lock means a panic while counting. Reporting nothing would be the silent
            // outcome; the log is what makes it visible.
            Err(_) => {
                tracing::error!("the usage accumulator was poisoned; this turn is not billed");
                return;
            }
        };

        let occurred_at = chrono::Utc::now().timestamp_millis();
        let batch = match meter::batch_for(&self.session, &self.request_id, usage, occurred_at) {
            Ok(Some(batch)) => batch,
            Ok(None) => return,
            Err(cause) => {
                tracing::error!(%cause, "could not build a usage batch");
                return;
            }
        };

        let (Some(url), Some(key)) = (
            self.state.ingest_url.clone(),
            self.state.metering_key.clone(),
        ) else {
            tracing::warn!(
                organization = %self.session.organization_id,
                "metering is not configured; this turn is not billed"
            );
            return;
        };

        let http = self.state.http.clone();
        // Spawned because `Drop` cannot await. The task outlives the response by design: the point
        // is to bill a turn whose client has already gone.
        tokio::spawn(async move {
            let signature = sproutos_metering_proto::sign(&batch, &key);
            let sent = http
                .post(&url)
                .header("x-metering-signature", signature)
                .json(&batch)
                .send()
                .await;
            match sent {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => {
                    tracing::error!(status = %response.status(), "metering ingest refused a batch");
                }
                Err(cause) => tracing::error!(%cause, "could not post a usage batch"),
            }
        });
    }
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let token = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

fn unauthorized(message: &'static str) -> Response {
    (StatusCode::UNAUTHORIZED, message).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_bearer_in_either_case() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer spa_x"));
        assert_eq!(bearer(&headers).as_deref(), Some("spa_x"));

        headers.insert("authorization", HeaderValue::from_static("bearer spa_y"));
        assert_eq!(bearer(&headers).as_deref(), Some("spa_y"));
    }

    #[test]
    fn ignores_a_header_that_is_not_a_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer(&headers), None);

        // An empty bearer is not a token. Treating it as one would hash the empty string and look
        // it up, which is a real lookup for a value an attacker can send.
        headers.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(bearer(&headers), None);
    }

    #[test]
    fn the_credential_headers_never_cross_the_hop() {
        // The one property this list exists for: whatever the sandbox sent as its own credential
        // must not reach the provider, and the provider's must not be visible to the sandbox.
        assert!(HOP_BY_HOP.contains(&"authorization"));
        assert!(HOP_BY_HOP.contains(&"x-api-key"));
        assert!(HOP_BY_HOP.contains(&"host"));
    }
}
