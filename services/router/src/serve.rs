//! The request path: resolve, invoke, reply.

use std::collections::HashMap;
use std::sync::Arc;

use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_lambda::primitives::Blob;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::payload::{Incoming, Reply, build_event, decode_body, status_of};
use crate::resolve::Resolver;

pub struct Router {
    pub resolver: Resolver,
    pub lambda: LambdaClient,
}

pub type Shared = Arc<Router>;

/// Headers we do not forward to the customer's function.
///
/// Hop-by-hop headers describe *this* connection, not the request, and forwarding them makes a
/// handler believe it owns a transfer encoding it does not. `RFC 9110 §7.6.1` lists them.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub async fn handle(
    State(state): State<Shared>,
    method: axum::http::Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(host) = headers.get("host").and_then(|value| value.to_str().ok()) else {
        return (StatusCode::BAD_REQUEST, "no host").into_response();
    };

    let Some(route) = state.resolver.resolve(host).await else {
        // Also the answer for a suspended project: the control plane withdrew the key, so there is
        // nothing to route to. Indistinguishable from a hostname that never existed, deliberately —
        // "this project exists but is not paying" is not a fact to hand to anyone who asks.
        return (StatusCode::NOT_FOUND, "no application here").into_response();
    };

    let event = build_event(Incoming {
        method: method.as_str(),
        path: uri.path(),
        query: uri.query().unwrap_or(""),
        headers: forwarded_headers(&headers),
        host,
        source_ip: &source_ip(&headers),
        request_id: &route.deployment_id,
        body: &body,
    });

    let payload = match serde_json::to_vec(&event) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(%error, "could not build the invocation payload");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let invoked = state
        .lambda
        .invoke()
        .function_name(&route.arn)
        .payload(Blob::new(payload))
        .send()
        .await;

    let output = match invoked {
        Ok(output) => output,
        Err(error) => {
            tracing::error!(%error, arn = route.arn, "invocation failed");
            return (StatusCode::BAD_GATEWAY, "the application did not respond").into_response();
        }
    };

    /*
      An unhandled error inside the customer's code, not a transport failure.

      Lambda returns 200 with `FunctionError` set, so treating a successful `invoke` as a successful
      request would serve the customer's stack trace to their visitors with a 200 on it.
    */
    if output.function_error().is_some() {
        tracing::warn!(arn = route.arn, "the function raised");
        return (StatusCode::BAD_GATEWAY, "the application errored").into_response();
    }

    let raw = output.payload().map(Blob::as_ref).unwrap_or_default();
    let reply: Reply = match serde_json::from_slice(raw) {
        Ok(reply) => reply,
        Err(error) => {
            tracing::warn!(%error, arn = route.arn, "the function returned something unreadable");
            return (
                StatusCode::BAD_GATEWAY,
                "the application returned nothing usable",
            )
                .into_response();
        }
    };

    let bytes = match decode_body(&reply) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(%error, arn = route.arn, "the function's base64 body did not decode");
            return (
                StatusCode::BAD_GATEWAY,
                "the application returned nothing usable",
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(status_of(&reply)).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = Response::builder().status(status);

    for (name, value) in &reply.headers {
        if HOP_BY_HOP.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        // A header the function invented that will not serialise is dropped rather than fatal: a
        // customer with one malformed header should lose the header, not the response.
        if let Ok(header) = HeaderValue::from_str(value) {
            response = response.header(name, header);
        }
    }

    response
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn forwarded_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(name, _)| !HOP_BY_HOP.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|text| (name.as_str().to_string(), text.to_string()))
        })
        .collect()
}

/// The client's address, from the ALB.
///
/// `X-Forwarded-For` is a list and the ALB appends, so the **first** entry is the client. Taking
/// the last would be taking the load balancer's own address on every request.
fn source_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|list| list.split(',').next())
        .map(|first| first.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderName;

    fn headers_from(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).expect("valid header name"),
                HeaderValue::from_str(value).expect("valid header value"),
            );
        }
        headers
    }

    #[test]
    fn takes_the_client_from_the_front_of_the_forwarded_list() {
        // The ALB appends its own hop. The last entry is the load balancer; the first is the person.
        let headers = headers_from(&[("x-forwarded-for", "203.0.113.7, 10.0.1.4, 10.0.2.9")]);

        assert_eq!(source_ip(&headers), "203.0.113.7");
    }

    #[test]
    fn has_no_source_ip_rather_than_a_wrong_one() {
        assert_eq!(source_ip(&HeaderMap::new()), "");
    }

    #[test]
    fn does_not_forward_headers_that_describe_our_own_connection() {
        let headers = headers_from(&[
            ("host", "myapp.sproutos.me"),
            ("connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
            ("x-real-header", "kept"),
        ]);

        let forwarded = forwarded_headers(&headers);

        // Forwarding these makes a handler believe it owns a framing it does not.
        assert!(!forwarded.contains_key("connection"));
        assert!(!forwarded.contains_key("transfer-encoding"));
        assert_eq!(
            forwarded.get("x-real-header").map(String::as_str),
            Some("kept")
        );
        assert_eq!(
            forwarded.get("host").map(String::as_str),
            Some("myapp.sproutos.me")
        );
    }
}
