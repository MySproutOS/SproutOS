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
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt as _;

use crate::meter;
use crate::session::Session;
use crate::spool::{MeteringSpool, SpoolReservation};
use crate::store::{SessionStore, StoreError};
use crate::usage::UsageAccumulator;

/// Headers that belong to *this* hop and must not be forwarded.
///
/// `host` because the upstream's virtual host is not ours; `authorization` and `x-api-key` because
/// the whole point is to replace the caller's credential with the real one; the connection headers
/// because they describe a connection that ends here. Forwarding `content-length` alongside a body
/// we may re-encode is how a proxy produces a truncated request nobody can explain.
// Headers the proxy must terminate rather than relay. Most are hop-by-hop. `accept-encoding` is
// also terminated because token accounting reads the provider body: reqwest advertises only the
// encodings it can decode, then hands both the counter and the client the decoded stream.
const STRIPPED_HEADERS: &[&str] = &[
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
    "accept-encoding",
];

/// Stop retaining an abandoned provider connection eventually, even if the provider never ends.
/// Normal connected streams have no proxy timeout; this bound starts only after the client leaves.
pub const ABANDONED_STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(120);
const RESPONSE_BUFFER_CHUNKS: usize = 8;

pub struct ProxyState {
    pub store: SessionStore,
    pub http: reqwest::Client,
    /// The durable queue for usage. Absent means metering is off, which is a development
    /// configuration and is logged loudly rather than assumed.
    pub metering: Option<MeteringSpool>,
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
        if STRIPPED_HEADERS.contains(&name.as_str()) {
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
    /*
      Whatever else the credential's kind requires — today, Anthropic's OAuth opt-in.

      The proxy is the side that knows what kind of credential this is; the client only knows it
      has a token. Ordinary headers replace client values. Anthropic's feature list is the exception:
      its OAuth opt-in is merged with the protocol features selected by Claude Code.
    */
    for (name, value) in session.upstream.extra_headers() {
        merge_upstream_header(&mut headers, name, value);
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

    /*
      Reserve before asking the provider to do billable work.

      A full spool is backpressure, not permission to make an unrecorded model call. Reserving here
      also means an abandoned response owns capacity until its reporter records what was observed.
    */
    let reservation = match state.metering.as_ref().map(MeteringSpool::reserve) {
        Some(Ok(reservation)) => Some(reservation),
        Some(Err(cause)) => {
            tracing::error!(%cause, "metering spool cannot accept another model turn");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "The model proxy is temporarily at metering capacity. Retry this turn.",
            )
                .into_response();
        }
        None => None,
    };

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
        if STRIPPED_HEADERS.contains(&name.as_str()) {
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
    let reporter = UsageReporter::new(session, request_id, reservation);
    let upstream_stream = upstream.bytes_stream();
    let stream = drain_to_client(upstream_stream, reporter, ABANDONED_STREAM_DRAIN_TIMEOUT);

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    response
}

/// Add a provider-required header without erasing feature opt-ins sent by the harness.
///
/// Anthropic uses one comma-separated `anthropic-beta` header for multiple independent features.
/// Claude Code sends the betas matching fields in its request body; an OAuth subscription adds a
/// separate authentication beta here. Replacing the former with the latter makes valid body fields
/// fail upstream as unknown inputs. Other provider headers retain ordinary replacement semantics.
fn merge_upstream_header(headers: &mut HeaderMap, name: &str, required: &str) {
    let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
        return;
    };

    let value = if name.as_str() == "anthropic-beta" {
        let existing = headers
            .get(&name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let already_present = existing
            .split(',')
            .map(str::trim)
            .any(|value| value == required);
        if existing.is_empty() {
            required.to_string()
        } else if already_present {
            existing.to_string()
        } else {
            format!("{existing},{required}")
        }
    } else {
        required.to_string()
    };

    if let Ok(value) = HeaderValue::from_str(&value) {
        headers.insert(name, value);
    }
}

fn drain_to_client<S, E>(
    upstream_stream: S,
    reporter: UsageReporter,
    abandoned_timeout: Duration,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, E>>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Send + 'static,
    E: Send + 'static,
{
    let (sender, receiver) = tokio::sync::mpsc::channel(RESPONSE_BUFFER_CHUNKS);
    tokio::spawn(async move {
        let mut upstream_stream = Box::pin(upstream_stream);
        let mut client_connected = true;
        let mut abandoned_deadline = None;
        loop {
            let next = if client_connected {
                tokio::select! {
                    () = sender.closed() => {
                        client_connected = false;
                        abandoned_deadline = Some(tokio::time::Instant::now() + abandoned_timeout);
                        continue;
                    }
                    next = upstream_stream.next() => next,
                }
            } else {
                match tokio::time::timeout_at(
                    abandoned_deadline.expect("an abandoned stream has a deadline"),
                    upstream_stream.next(),
                )
                .await
                {
                    Ok(next) => next,
                    Err(_) => {
                        tracing::error!(
                            timeout_seconds = abandoned_timeout.as_secs(),
                            "the provider never finished an abandoned stream; billing what was observed"
                        );
                        break;
                    }
                }
            };

            let Some(chunk) = next else { break };
            if let Ok(bytes) = &chunk {
                reporter.observe(&String::from_utf8_lossy(bytes));
            }
            if client_connected && sender.send(chunk).await.is_err() {
                client_connected = false;
                abandoned_deadline = Some(tokio::time::Instant::now() + abandoned_timeout);
            }
        }
        // The reporter drops here, after terminal usage or the explicit abandoned-stream bound.
    });

    futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|chunk| (chunk, receiver))
    })
}

/// Persists usage when the provider drain ends, whether or not the downstream client stayed.
pub struct UsageReporter {
    session: Session,
    request_id: String,
    accumulator: std::sync::Mutex<UsageAccumulator>,
    reservation: Option<SpoolReservation>,
}

impl UsageReporter {
    fn new(session: Session, request_id: String, reservation: Option<SpoolReservation>) -> Self {
        Self {
            session,
            request_id,
            accumulator: std::sync::Mutex::new(UsageAccumulator::new()),
            reservation,
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

        let Some(reservation) = self.reservation.take() else {
            tracing::warn!(
                organization = %self.session.organization_id,
                "metering is not configured; this turn is not billed"
            );
            return;
        };
        if let Err(cause) = reservation.commit(&batch) {
            // Drop cannot return an error to the already-finished response. This must be loud: it
            // means capacity was reserved but the host could not durably record spent work.
            tracing::error!(%cause, "could not commit a billable turn to the metering spool");
        }
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
    use std::convert::Infallible;

    use crate::session::Upstream;
    use crate::spool::SpoolLimits;

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
        assert!(STRIPPED_HEADERS.contains(&"authorization"));
        assert!(STRIPPED_HEADERS.contains(&"x-api-key"));
        assert!(STRIPPED_HEADERS.contains(&"host"));
        assert!(STRIPPED_HEADERS.contains(&"accept-encoding"));
    }

    #[test]
    fn oauth_authentication_preserves_claude_codes_beta_features() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("context-management-2025-06-27"),
        );

        merge_upstream_header(&mut headers, "anthropic-beta", "oauth-2025-04-20");

        assert_eq!(
            headers.get("anthropic-beta").unwrap(),
            "context-management-2025-06-27,oauth-2025-04-20"
        );
    }

    #[test]
    fn oauth_authentication_does_not_duplicate_its_beta() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("context-management-2025-06-27, oauth-2025-04-20"),
        );

        merge_upstream_header(&mut headers, "anthropic-beta", "oauth-2025-04-20");

        assert_eq!(
            headers.get("anthropic-beta").unwrap(),
            "context-management-2025-06-27, oauth-2025-04-20"
        );
    }

    #[tokio::test]
    async fn abandoning_the_client_still_drains_terminal_provider_usage() {
        let directory = std::env::temp_dir().join(format!(
            "sproutos-llm-abandoned-stream-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let spool = MeteringSpool::open(&directory, SpoolLimits::default()).unwrap();
        let reporter = UsageReporter::new(
            Session {
                token_id: "01a03e5d-8cbf-7415-9ac6-82c3476aeb5c".into(),
                organization_id: "01a03b00-0000-7000-8000-00000000beef".into(),
                project_id: None,
                charged_externally: true,
                upstream: Upstream::Anthropic,
                base_url: "https://api.anthropic.com".into(),
                secret: "not-used".into(),
            },
            "request-1".into(),
            Some(spool.reserve().unwrap()),
        );
        let provider = futures_util::stream::unfold(0_u8, |part| async move {
            match part {
                0 => Some((
                    Ok::<_, Infallible>(bytes::Bytes::from_static(
                        concat!(
                            "data: ",
                            r#"{"type":"message_start","message":{"usage":{"input_tokens":41}}}"#,
                            "\n\n"
                        )
                        .as_bytes(),
                    )),
                    1,
                )),
                1 => {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    Some((
                        Ok(bytes::Bytes::from_static(
                            concat!(
                                "data: ",
                                r#"{"type":"message_delta","usage":{"output_tokens":58}}"#,
                                "\n\ndata: [DONE]\n\n"
                            )
                            .as_bytes(),
                        )),
                        2,
                    ))
                }
                _ => None,
            }
        });
        let mut client = Box::pin(drain_to_client(provider, reporter, Duration::from_secs(1)));
        let first = client.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&first).contains("message_start"));
        drop(client);

        for _ in 0..100 {
            if spool.pending_records() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(spool.pending_records(), 1);
        let path = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().and_then(|it| it.to_str()) == Some("json"))
            .unwrap();
        let batch: sproutos_metering_proto::UsageBatch =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let output = batch
            .events
            .iter()
            .find(|event| event.dimension == sproutos_metering_proto::UsageDimension::AiOutputToken)
            .expect("terminal output usage should be retained after abandonment");
        assert_eq!(output.quantity, 58.0);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
