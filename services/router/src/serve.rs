//! The request path: resolve, invoke, reply.

use std::collections::HashMap;
use std::sync::Arc;

use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_lambda::primitives::Blob;
use aws_types::request_id::RequestId as _;
use axum::body::Bytes;
use axum::extract::{Extension, State};
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::payload::{Incoming, Reply, build_event, decode_body, status_of};
use crate::resolve::Resolver;

pub struct Router {
    pub resolver: Resolver,
    pub lambda: LambdaClient,
    /// The longest any invocation may be waited on. A well-funded customer gets all of it.
    pub function_timeout: std::time::Duration,
    /// Where runtime logs go. `None` where no broker is configured — a development router accepts
    /// and discards rather than failing an extension that is only doing its job.
    pub logs: Option<crate::logs::LogSink>,
    /// Verifies the token an extension presents. Empty where logging is unconfigured, in which case
    /// `logs` is `None` and it is never consulted.
    pub log_token_secret: Vec<u8>,
    /// Durable billing observed at this boundary. Optional in development and fail-open on
    /// capacity: metering trouble is never allowed to take a tenant application down.
    pub site_meter: Option<crate::site_metering::SiteMeter>,
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

/// Address assertions set by CDNs and reverse proxies. On the Rust edge the socket/Proxy Protocol
/// context is authoritative, so forwarding any client-supplied spelling invites a tenant framework
/// to trust a spoof even though Lambda's own `sourceIp` is correct.
const UNTRUSTED_CLIENT_ADDRESS_HEADERS: [&str; 17] = [
    "client-ip",
    "cf-connecting-ip",
    "cf-connecting-ipv6",
    "fastly-client-ip",
    "fly-client-ip",
    "true-client-ip",
    "x-appengine-user-ip",
    "x-azure-clientip",
    "x-client-ip",
    "x-cluster-client-ip",
    "x-envoy-external-address",
    "x-original-forwarded-for",
    "x-originating-ip",
    "x-proxyuser-ip",
    "x-remote-addr",
    "x-real-ip",
    "x-remote-ip",
];

/// The load balancer's probe. Answered before host resolution, because the probe has no tenant.
pub const HEALTH_PATH: &str = "/healthz";

pub async fn handle(
    State(state): State<Shared>,
    method: axum::http::Method,
    uri: Uri,
    headers: HeaderMap,
    trusted: Option<Extension<crate::edge::ConnectionContext>>,
    body: Bytes,
) -> Response {
    let trusted = trusted.as_deref();
    let host = headers.get("host").and_then(|value| value.to_str().ok());

    /*
      Health first, and only for a request that is not for a tenant.

      Reserving `/healthz` outright would take that path away from every customer application. The
      load balancer probes by IP, so its `Host` is the instance address and never a hostname with a
      route — which means `is_tenant_host` is what separates "the ALB is asking" from "a visitor
      asked for a page the customer happens to have called /healthz".
    */
    if uri.path() == HEALTH_PATH {
        let known = match host {
            Some(name) => state.resolver.resolve(name).await.is_some(),
            None => false,
        };
        if !known {
            return (StatusCode::OK, "ok").into_response();
        }
    }

    /*
      Log ingest, also before host resolution and for the same reason: the extension posting a
      customer's logs is not itself a customer request, and the `Host` it arrives with is whatever
      the router was reached by.

      Unlike `/healthz` this path is reserved outright, prefix and all. `/healthz` can be given back
      to a tenant because the probe is distinguishable by its host; this cannot, because a tenant
      hostname *is* how the extension reaches us. The `_sproutos/` prefix is the price, and it is
      documented in the deploy action so nobody builds an application route there by accident.
    */
    if uri.path() == crate::logs::INGEST_PATH {
        return ingest_logs(&state, &method, &headers, &body);
    }

    let Some(host) = host else {
        return (StatusCode::BAD_REQUEST, "no host").into_response();
    };

    let Some(route) = state.resolver.resolve(host).await else {
        // Also the answer for a suspended project: the control plane withdrew the key, so there is
        // nothing to route to. Indistinguishable from a hostname that never existed, deliberately —
        // "this project exists but is not paying" is not a fact to hand to anyone who asks.
        return (StatusCode::NOT_FOUND, "no application here").into_response();
    };

    /*
      Credit, before anything is spent.

      Read after resolution because the answer is per organization and the route is what says which
      one. Refusing here is the only thing that actually stops spend — once Lambda is running we are
      paying for it, and there is no API to abort an invocation in flight.
    */
    let credit = crate::credit::read_credit(state.resolver.valkey(), &route.organization_id).await;
    if credit == crate::credit::Credit::Exhausted {
        // 402, not 404. A suspended project is indistinguishable from an unknown host by design,
        // but an *exhausted* one belongs to a customer who can fix it, and telling them so is the
        // difference between a bill they can pay and an outage they cannot explain.
        return (
            StatusCode::PAYMENT_REQUIRED,
            "This application is out of credit. Add credit to bring it back.",
        )
            .into_response();
    }

    let event = build_event(Incoming {
        method: method.as_str(),
        path: uri.path(),
        query: uri.query().unwrap_or(""),
        headers: forwarded_headers(&headers, trusted),
        host,
        source_ip: &source_ip(&headers, trusted),
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

    let invocation = state
        .lambda
        .invoke()
        .function_name(&route.arn)
        .payload(Blob::new(payload))
        .send();

    /*
      Stop waiting, which is not the same as stopping the invocation.

      AWS has no API to abort a Lambda in flight: the function keeps running and keeps billing us
      until it finishes or hits its own configured timeout. What this does is cut the client off so
      a customer who is nearly out of credit is not held on a request whose cost they cannot cover.
      The controls that actually bound the spend are the function's timeout and its reserved
      concurrency, both set at publish.
    */
    let ceiling = crate::credit::deadline(credit, state.function_timeout);
    let output = match tokio::time::timeout(ceiling, invocation).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            tracing::error!(%error, arn = route.arn, "invocation failed");
            return (StatusCode::BAD_GATEWAY, "the application did not respond").into_response();
        }
        Err(_) => {
            // Recorded, so a customer can see why their request was cut short rather than guessing.
            tracing::warn!(
                arn = route.arn,
                organization = route.organization_id,
                seconds = ceiling.as_secs(),
                "cut off a long invocation on a low balance"
            );
            return (
                StatusCode::GATEWAY_TIMEOUT,
                "This request ran longer than the remaining credit allows.",
            )
                .into_response();
        }
    };
    let invocation_request_id = output.request_id().map(str::to_owned);

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

    if let Some(meter) = state.site_meter.as_ref()
        && !bytes.is_empty()
    {
        let _ = meter.record_egress(
            &route,
            invocation_request_id.as_deref().unwrap_or_default(),
            bytes.len(),
            crate::site_metering::now_millis(),
        );
    }

    reply_response(&reply, bytes)
}

/// Turn an API Gateway HTTP API v2 reply into the response sent to the visitor.
///
/// Kept as one tested boundary because `cookies` are not ordinary JSON headers: v2 puts each one
/// in a top-level array specifically so repeated `Set-Cookie` fields are not collapsed.
fn reply_response(reply: &Reply, bytes: Vec<u8>) -> Response {
    let status = StatusCode::from_u16(status_of(reply)).unwrap_or(StatusCode::BAD_GATEWAY);
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

    for cookie in &reply.cookies {
        // Match ordinary response-header handling: one malformed value loses only itself, not the
        // customer's otherwise valid response or the other cookies beside it.
        if let Ok(cookie) = HeaderValue::from_str(cookie) {
            response = response.header(SET_COOKIE, cookie);
        }
    }

    response
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod response_tests {
    use super::*;

    #[test]
    fn forwards_every_v2_cookie_without_replacing_headers_or_each_other() {
        let reply: Reply = serde_json::from_str(
            r#"{
                "statusCode": 201,
                "headers": {
                    "content-type": "application/json",
                    "set-cookie": "legacy=kept; Path=/"
                },
                "cookies": [
                    "session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
                    "csrf=def; Path=/; Secure; SameSite=Strict"
                ],
                "body": "{}"
            }"#,
        )
        .expect("reply deserialises");

        let response = reply_response(&reply, b"{}".to_vec());

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()["content-type"], "application/json");
        let cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().expect("valid cookie"))
            .collect::<Vec<_>>();
        assert_eq!(
            cookies,
            [
                "legacy=kept; Path=/",
                "session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
                "csrf=def; Path=/; Secure; SameSite=Strict",
            ]
        );
    }

    #[test]
    fn a_malformed_cookie_does_not_drop_the_response_or_valid_cookies() {
        let reply: Reply = serde_json::from_str(
            r#"{"statusCode":200,"cookies":["bad\nvalue","session=good; Path=/"],"body":"ok"}"#,
        )
        .expect("reply deserialises");

        let response = reply_response(&reply, b"ok".to_vec());

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 1);
        assert_eq!(response.headers()[SET_COOKIE], "session=good; Path=/");
    }
}

fn forwarded_headers(
    headers: &HeaderMap,
    trusted: Option<&crate::edge::ConnectionContext>,
) -> HashMap<String, String> {
    let mut forwarded = headers
        .iter()
        .filter(|(name, _)| !HOP_BY_HOP.contains(&name.as_str()))
        .filter(|(name, _)| {
            trusted.is_none()
                || (name.as_str() != "forwarded"
                    && !name.as_str().starts_with("x-forwarded-")
                    && !UNTRUSTED_CLIENT_ADDRESS_HEADERS.contains(&name.as_str()))
        })
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|text| (name.as_str().to_string(), text.to_string()))
        })
        .collect::<HashMap<_, _>>();
    if let Some(context) = trusted {
        let peer = context.peer.ip();
        let forwarding_identifier = if peer.is_ipv6() {
            format!("\"[{peer}]\"")
        } else {
            peer.to_string()
        };
        forwarded.insert("x-forwarded-for".into(), peer.to_string());
        forwarded.insert("x-forwarded-host".into(), context.sni.to_string());
        forwarded.insert("x-forwarded-proto".into(), context.scheme.into());
        forwarded.insert("x-forwarded-port".into(), "443".into());
        forwarded.insert(
            "forwarded".into(),
            format!(
                "for={forwarding_identifier};proto={};host=\"{}\"",
                context.scheme, context.sni
            ),
        );
    }
    forwarded
}

/// The client's address, from the ALB.
///
/// `X-Forwarded-For` is a list and the ALB appends, so the **first** entry is the client. Taking
/// the last would be taking the load balancer's own address on every request.
fn source_ip(headers: &HeaderMap, trusted: Option<&crate::edge::ConnectionContext>) -> String {
    if let Some(context) = trusted {
        return context.peer.ip().to_string();
    }
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|list| list.split(',').next())
        .map(|first| first.trim().to_string())
        .unwrap_or_default()
}

/// Accept a batch of runtime logs from a Lambda extension.
///
/// The handler does three things and none of them is "talk to Kafka": verify the token, stamp the
/// project it proves onto every record, and hand the batch to the producer task. The caller is an
/// extension holding a customer's invocation open, so this returns in microseconds whether or not
/// the broker is reachable.
fn ingest_logs(
    state: &Shared,
    method: &axum::http::Method,
    headers: &HeaderMap,
    body: &Bytes,
) -> Response {
    if method != axum::http::Method::POST {
        return (StatusCode::METHOD_NOT_ALLOWED, "post logs here").into_response();
    }

    if state.logs.is_none() && state.site_meter.is_none() {
        // Nothing consumes the body in this development configuration. Preserve the old no-op
        // endpoint so attaching the extension locally does not require production credentials.
        return (StatusCode::ACCEPTED, "logging is not configured").into_response();
    }

    let Some(token) = crate::logs::bearer(
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
    ) else {
        return (StatusCode::UNAUTHORIZED, "no token").into_response();
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);

    let Ok(claims) = crate::log_token::claims_of(token, &state.log_token_secret, now) else {
        // One answer for malformed, mis-signed and expired alike. Which of the three it was is a
        // hint to somebody working through guesses, and of no use to a correctly configured
        // extension.
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    };

    let Ok(records) = serde_json::from_slice::<Vec<crate::logs::IncomingRecord>>(body) else {
        return (StatusCode::BAD_REQUEST, "expected an array of log records").into_response();
    };

    // The deployment is a header rather than part of the token: it changes on every release, and
    // reminting a token per deployment would mean a token whose lifetime is a deployment's. It is
    // not a security claim — it only labels which release a line came from, within a project the
    // token already proved.
    let deployment_id = headers
        .get("x-sproutos-deployment")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let stamped: Vec<_> = records
        .into_iter()
        .map(|record| crate::logs::stamp(record, &claims.project_id, deployment_id))
        .collect();

    if let Some(meter) = state.site_meter.as_ref() {
        let outcomes = meter.record_reports(&claims, &stamped);
        let unavailable = outcomes
            .iter()
            .filter(|outcome| **outcome == crate::site_metering::Recorded::CapacityUnavailable)
            .count();
        if unavailable > 0 {
            tracing::error!(
                unavailable,
                project_id = claims.project_id,
                organization_id = claims.organization_id.as_deref().unwrap_or("legacy-token"),
                "runtime usage was not durably recorded; accepting telemetry to keep tenant traffic fail-open"
            );
        }
    }

    let Some(sink) = state.logs.as_ref() else {
        // Metering above is independent of Kafka. A developer with no broker still gets the same
        // accepted response, while a configured site meter can durably record platform reports.
        return (StatusCode::ACCEPTED, "logging is not configured").into_response();
    };

    match sink.offer(stamped) {
        crate::logs::Accepted::Queued(count) => {
            (StatusCode::ACCEPTED, format!("{count}")).into_response()
        }
        /*
          Dropped, and still a 2xx.

          The extension cannot do anything useful with a failure: it has already handed the lines
          off, it is inside a customer's invocation, and retrying would spend their money to deliver
          our telemetry. Telling it we are behind would only make it retry. The drop is counted
          here, where somebody can act on it.
        */
        crate::logs::Accepted::Dropped(count) => {
            tracing::warn!(
                count,
                project_id = claims.project_id,
                "log queue full; dropped a batch"
            );
            (StatusCode::ACCEPTED, "dropped").into_response()
        }
    }
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

        assert_eq!(source_ip(&headers, None), "203.0.113.7");
    }

    #[test]
    fn has_no_source_ip_rather_than_a_wrong_one() {
        assert_eq!(source_ip(&HeaderMap::new(), None), "");
    }

    #[test]
    fn does_not_forward_headers_that_describe_our_own_connection() {
        let headers = headers_from(&[
            ("host", "myapp.sproutos.me"),
            ("connection", "keep-alive"),
            ("transfer-encoding", "chunked"),
            ("x-real-header", "kept"),
        ]);

        let forwarded = forwarded_headers(&headers, None);

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

    #[test]
    fn tls_edge_replaces_untrusted_forwarding_headers_with_socket_context() {
        let headers = headers_from(&[
            ("host", "app.example.test"),
            ("forwarded", "for=198.51.100.9;proto=http"),
            ("x-forwarded-for", "198.51.100.9"),
            ("x-forwarded-host", "attacker.example"),
            ("x-forwarded-proto", "http"),
            ("x-forwarded-port", "80"),
            ("x-real-ip", "198.51.100.10"),
            ("true-client-ip", "198.51.100.11"),
            ("cf-connecting-ip", "198.51.100.12"),
            ("x-envoy-external-address", "198.51.100.13"),
            ("x-original-forwarded-for", "198.51.100.14"),
            ("x-real-header", "kept"),
        ]);
        let context = crate::edge::ConnectionContext {
            peer: "203.0.113.7:49152".parse().unwrap(),
            sni: Arc::from("app.example.test"),
            scheme: "https",
        };

        let forwarded = forwarded_headers(&headers, Some(&context));

        assert_eq!(source_ip(&headers, Some(&context)), "203.0.113.7");
        assert_eq!(forwarded["x-forwarded-for"], "203.0.113.7");
        assert_eq!(forwarded["x-forwarded-host"], "app.example.test");
        assert_eq!(forwarded["x-forwarded-proto"], "https");
        assert_eq!(forwarded["x-forwarded-port"], "443");
        assert!(!forwarded.contains_key("x-real-ip"));
        assert!(!forwarded.contains_key("true-client-ip"));
        assert!(!forwarded.contains_key("cf-connecting-ip"));
        assert!(!forwarded.contains_key("x-envoy-external-address"));
        assert!(!forwarded.contains_key("x-original-forwarded-for"));
        assert_eq!(
            forwarded["forwarded"],
            "for=203.0.113.7;proto=https;host=\"app.example.test\""
        );
        assert_eq!(forwarded["x-real-header"], "kept");
    }
}
