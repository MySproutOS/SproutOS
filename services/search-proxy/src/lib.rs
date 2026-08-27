//! The search proxy (TASK 33).
//!
//! > We can also utilize Elasticsearch as an offering, and make it tenant split such that an
//! > Elasticsearch database shares resources with others. We manage the database ourselves in EC2
//! > instances.
//!
//! One cluster, many tenants, split by index name. A tenant points an Elasticsearch or OpenSearch
//! client at this as though it were their own cluster; it authenticates them, rewrites every index
//! name they mention into their own namespace, and forwards to the shared cluster.
//!
//! This proxy authenticates and namespaces every supported request, then authenticates upstream as
//! a matching OpenSearch internal user whose role can access only that namespace. The parser keeps
//! customer-facing names tidy and narrows the API; the server-enforced role is the backstop that
//! makes a missed present or future body shape fail closed.
//!
//! Rust because it sits in front of every search request a tenant makes, and because the rewriting
//! is byte work on bodies that can be megabytes.

pub mod body;
pub mod naming;
pub mod routes;
pub mod security;

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use sproutos_service_credentials::{Authentication, CredentialStore, report};
use sproutos_tenant_auth::{ResourceKind, TenantIdentity};
use tracing::warn;

use crate::body::{rewrite_mget, rewrite_ndjson, strip_prefix_from_response};
use crate::routes::{Plan, RouteError, plan, validate_query};
use crate::security::SecurityManager;

/// The largest body this proxy will hold.
///
/// A bulk index of a million documents is a legitimate thing to do and a legitimate thing to do in
/// batches. 64 MiB is well past any client's default batch and bounds what one request can make
/// this process allocate.
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub struct Proxy {
    pub store: Arc<CredentialStore>,
    pub upstream: String,
    pub client: reqwest::Client,
    /// Provisions the server-enforced role before forwarding. Required: there is deliberately no
    /// parser-only mode, because it would turn a missing deployment secret into weaker isolation.
    pub security: SecurityManager,
}

/// Headers that must not be forwarded upstream.
///
/// `authorization` above all: it carries the *tenant's* credentials, which mean nothing to the
/// cluster and would be a credential leaving our trust boundary. `host` would make the upstream
/// resolve the wrong virtual host; the rest are hop-by-hop and belong to this connection.
const STRIPPED_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "accept-encoding",
    "host",
    "connection",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "x-proxy-user",
    "x-proxy-roles",
];

/// Headers that must not be forwarded back.
///
/// `content-length` because the body's length changes when the prefix is stripped out of it, and a
/// header that disagrees with the body is a response the client either truncates or hangs on.
const STRIPPED_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "content-length",
    "transfer-encoding",
    "content-encoding",
];

fn strip_request_header(name: &HeaderName) -> bool {
    STRIPPED_REQUEST_HEADERS.contains(&name.as_str())
}

fn error(status: StatusCode, message: &str) -> Response {
    // OpenSearch's own error shape, so a client's error handling works unchanged rather than
    // finding a body it cannot parse where it expected a structured error.
    let body = serde_json::json!({
        "error": { "type": "security_exception", "reason": message },
        "status": status.as_u16(),
    });
    (status, axum::Json(body)).into_response()
}

/// Reads `Authorization: Basic` into a username and secret.
///
/// Basic auth because every Elasticsearch and OpenSearch client supports it and most default to it.
/// A bearer token would mean a tenant configuring a custom header in a client that may not have
/// one.
fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let encoded = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let (username, secret) = text.split_once(':')?;
    Some((username.to_owned(), secret.to_owned()))
}

pub async fn handle(State(proxy): State<Arc<Proxy>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();

    let Some((username, secret)) = basic_credentials(&parts.headers) else {
        return error(
            StatusCode::UNAUTHORIZED,
            "Missing credentials. Send HTTP basic auth with your index username and secret.",
        );
    };

    let identity: TenantIdentity =
        match proxy.store.authenticate(&username, secret.as_bytes()).await {
            Ok(Authentication::Ok(tenant)) => tenant.identity,
            // One answer for "no such tenant" and "wrong secret", because two answers let anyone
            // enumerate which tenants exist.
            Ok(Authentication::Denied) => {
                warn!(username, "authentication denied");
                return error(StatusCode::UNAUTHORIZED, "Invalid username or password");
            }
            Err(cause) => {
                report(&cause);
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The service is temporarily unavailable; retry shortly",
                );
            }
        };

    let prefix = naming::prefix_for(&identity);

    // The username grammar and credential store are shared by every tenant split. A valid queue
    // credential must not become a search credential merely because it authenticates successfully.
    if identity.resource_kind != ResourceKind::SearchIndex {
        warn!(tenant = %identity, "credential belongs to a different resource kind");
        return error(StatusCode::UNAUTHORIZED, "Invalid username or password");
    }

    let security_identity = match proxy.security.ensure(&identity, &prefix).await {
        Ok(identity) => identity,
        Err(cause) => {
            warn!(tenant = %identity, %cause, "tenant security provisioning failed");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The service is temporarily unavailable; retry shortly",
            );
        }
    };

    let planned = match plan(&prefix, &parts.method, parts.uri.path()) {
        Ok(planned) => planned,
        Err(RouteError::Refused(endpoint)) => {
            warn!(tenant = %identity, endpoint, "refused");
            return error(
                StatusCode::FORBIDDEN,
                &format!("{endpoint} is not available through this endpoint"),
            );
        }
        Err(RouteError::Index(cause)) => {
            return error(StatusCode::BAD_REQUEST, &cause.to_string());
        }
        Err(
            cause @ (RouteError::Query(_) | RouteError::DuplicateQuery(_) | RouteError::Encoding),
        ) => {
            return error(StatusCode::BAD_REQUEST, &cause.to_string());
        }
    };

    if let Err(cause) = validate_query(parts.uri.query()) {
        return error(StatusCode::BAD_REQUEST, &cause.to_string());
    }

    // Read the body *after* authentication, so an unauthenticated caller never makes us hold 64 MiB.
    let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("Request bodies are limited to {MAX_BODY_BYTES} bytes"),
            );
        }
    };

    let (path, forwarded) = match planned {
        Plan::Path(path) => (path, bytes),
        Plan::PathAndNdjson(path) => match rewrite_ndjson(&prefix, &bytes) {
            Ok(rewritten) => (path, Bytes::from(rewritten)),
            Err(cause) => return error(StatusCode::BAD_REQUEST, &cause.to_string()),
        },
        Plan::PathAndMget {
            path,
            index_in_path,
        } => match rewrite_mget(&prefix, &bytes, index_in_path) {
            Ok(rewritten) => (path, Bytes::from(rewritten)),
            Err(cause) => return error(StatusCode::BAD_REQUEST, &cause.to_string()),
        },
    };

    forward(
        &proxy,
        &parts.method,
        &parts.uri,
        &path,
        &parts.headers,
        forwarded,
        &security_identity,
    )
    .await
}

async fn forward(
    proxy: &Proxy,
    method: &Method,
    uri: &Uri,
    path: &str,
    headers: &HeaderMap,
    body: Bytes,
    security: &crate::security::TenantSecurityIdentity,
) -> Response {
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{path}{query}", proxy.upstream.trim_end_matches('/'));

    let mut request = proxy.client.request(method.clone(), &target).body(body);
    for (name, value) in headers {
        if strip_request_header(name) {
            continue;
        }
        request = request.header(name, value);
    }

    /*
      Set after the loop, never inside it.

      `authorization` is stripped above because it is the *tenant's*, and this replaces it with the
      proxy's own. Ordering is the whole safety property: if this were applied first the tenant's
      header would overwrite it on the next iteration, and the request would reach the cluster
      carrying a credential the cluster has never heard of — which fails closed, but only by luck.
    */
    // Set after tenant-controlled Authorization has been stripped. This is a matching OpenSearch
    // internal user with an HMAC-derived password that is never stored or given to the tenant.
    request = request.basic_auth(&security.user, Some(&security.password));

    let response = match request.send().await {
        Ok(response) => response,
        Err(cause) => {
            warn!(%cause, "upstream request failed");
            return error(
                StatusCode::BAD_GATEWAY,
                "The search cluster did not respond",
            );
        }
    };

    let status = StatusCode::from_u16(response.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let upstream_headers = response.headers().clone();

    let payload = match response.bytes().await {
        Ok(payload) => payload,
        Err(cause) => {
            warn!(%cause, "could not read the upstream response");
            return error(
                StatusCode::BAD_GATEWAY,
                "The search cluster did not respond",
            );
        }
    };

    // Every response, not only successful ones: an OpenSearch error message names the index it
    // objected to, and that name is the namespaced one.
    let stripped = strip_prefix_from_response(&security.index_prefix, &payload);

    let mut out = Response::builder().status(status);
    for (name, value) in &upstream_headers {
        if STRIPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        out = out.header(name, value);
    }
    out = out.header(
        HeaderName::from_static("content-length"),
        HeaderValue::from(stripped.len()),
    );

    out.body(axum::body::Body::from(stripped))
        .unwrap_or_else(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not build a response",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_compression_is_disabled_before_response_rewriting() {
        assert!(strip_request_header(&HeaderName::from_static(
            "accept-encoding"
        )));
        assert!(!strip_request_header(&HeaderName::from_static("accept")));
    }

    #[test]
    fn tenant_cannot_assert_an_opensearch_identity() {
        assert!(strip_request_header(&HeaderName::from_static(
            "x-proxy-user"
        )));
        assert!(strip_request_header(&HeaderName::from_static(
            "x-proxy-roles"
        )));
    }
}
