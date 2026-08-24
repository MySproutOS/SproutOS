//! Turning an HTTP request into what a Lambda handler expects, and back.
//!
//! The format is API Gateway's **HTTP API v2** event, not v1 and not the ALB event. That choice is
//! worth stating because it is invisible once made and expensive to change: v2 is what every
//! current framework adapter reads — `@vendia/serverless-express`, Next.js's own adapter, Mangum on
//! the Python side — so a customer's app works unmodified. v1 is legacy and its `multiValueHeaders`
//! shape differs; the ALB event looks similar and is subtly not the same.
//!
//! We are not API Gateway. We produce the event ourselves and invoke Lambda directly, which is the
//! whole point of the router: no API Gateway bill, no second hop, and the tenant split happens here
//! where we can see it.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

/// The event a handler receives. Only the fields adapters actually read.
#[derive(Debug, Serialize)]
pub struct Event {
    pub version: &'static str,
    #[serde(rename = "rawPath")]
    pub raw_path: String,
    #[serde(rename = "rawQueryString")]
    pub raw_query_string: String,
    pub headers: HashMap<String, String>,
    #[serde(rename = "requestContext")]
    pub request_context: RequestContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(rename = "isBase64Encoded")]
    pub is_base64_encoded: bool,
}

#[derive(Debug, Serialize)]
pub struct RequestContext {
    pub http: Http,
    /// Adapters read this to build the request URL. It is the customer's hostname, not ours.
    #[serde(rename = "domainName")]
    pub domain_name: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Debug, Serialize)]
pub struct Http {
    pub method: String,
    pub path: String,
    pub protocol: &'static str,
    #[serde(rename = "sourceIp")]
    pub source_ip: String,
}

/// What a handler returns.
///
/// Every field is optional because handlers omit them freely, and a strict shape here means a
/// customer's working app returns 502 from our deserializer rather than the response it sent.
#[derive(Debug, Default, Deserialize)]
pub struct Reply {
    #[serde(rename = "statusCode")]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    #[serde(rename = "isBase64Encoded", default)]
    pub is_base64_encoded: bool,
}

/// Build the event for one request.
///
/// `body` is bytes, and whether it is sent as text or base64 is decided by whether it is valid
/// UTF-8 — not by the content type. A `Content-Type: application/json` with a truncated multi-byte
/// sequence is still bytes we must not mangle, and a `application/octet-stream` that happens to be
/// ASCII loses nothing by going as text.
pub fn build_event(request: Incoming<'_>) -> Event {
    let (encoded, is_base64) = encode_body(request.body);

    Event {
        version: "2.0",
        raw_path: request.path.to_string(),
        raw_query_string: request.query.to_string(),
        headers: request.headers,
        request_context: RequestContext {
            http: Http {
                method: request.method.to_string(),
                path: request.path.to_string(),
                protocol: "HTTP/1.1",
                source_ip: request.source_ip.to_string(),
            },
            domain_name: request.host.to_string(),
            request_id: request.request_id.to_string(),
        },
        body: encoded,
        is_base64_encoded: is_base64,
    }
}

/// The request being translated.
///
/// A struct rather than eight positional arguments: `method`, `path`, `query`, `host`, `source_ip`
/// and `request_id` are all `&str`, so any two of them can be swapped at a call site and nothing —
/// not the compiler, not a test of this function alone — would say so.
pub struct Incoming<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub headers: HashMap<String, String>,
    pub host: &'a str,
    pub source_ip: &'a str,
    pub request_id: &'a str,
    pub body: &'a [u8],
}

fn encode_body(body: &[u8]) -> (Option<String>, bool) {
    if body.is_empty() {
        // Absent, not empty-string. An adapter that checks `body != null` would otherwise see a
        // body on every GET and some frameworks then wait for a request stream that never ends.
        return (None, false);
    }

    match std::str::from_utf8(body) {
        Ok(text) => (Some(text.to_string()), false),
        Err(_) => (Some(BASE64.encode(body)), true),
    }
}

/// The response bytes a handler meant, decoded.
///
/// A `isBase64Encoded` body that will not decode is an error rather than a fallback to the raw
/// string: serving the base64 text as if it were the image would produce a broken page that looks
/// like the customer's bug.
pub fn decode_body(reply: &Reply) -> Result<Vec<u8>, base64::DecodeError> {
    let Some(body) = reply.body.as_ref() else {
        return Ok(Vec::new());
    };

    if reply.is_base64_encoded {
        BASE64.decode(body)
    } else {
        Ok(body.clone().into_bytes())
    }
}

/// The status to send. A handler that returns no `statusCode` meant 200 — that is what every
/// adapter does with a bare return, and 502 would be a worse guess than the one the spec makes.
pub fn status_of(reply: &Reply) -> u16 {
    reply.status_code.unwrap_or(200)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers() -> HashMap<String, String> {
        HashMap::from([("host".to_string(), "myapp.sproutos.me".to_string())])
    }

    fn event_for(body: &[u8]) -> Event {
        build_event(Incoming {
            method: "POST",
            path: "/api/items",
            query: "page=2",
            headers: headers(),
            host: "myapp.sproutos.me",
            source_ip: "203.0.113.7",
            request_id: "req-1",
            body,
        })
    }

    #[test]
    fn emits_the_v2_shape_adapters_read() {
        let event = event_for(b"");
        let json = serde_json::to_value(&event).expect("serialises");

        // Every one of these is a field an adapter dereferences. A rename is a customer's app
        // returning 500 with a stack trace inside somebody else's library.
        assert_eq!(json["version"], "2.0");
        assert_eq!(json["rawPath"], "/api/items");
        assert_eq!(json["rawQueryString"], "page=2");
        assert_eq!(json["requestContext"]["http"]["method"], "POST");
        assert_eq!(json["requestContext"]["http"]["sourceIp"], "203.0.113.7");
        assert_eq!(json["requestContext"]["domainName"], "myapp.sproutos.me");
    }

    #[test]
    fn an_empty_body_is_absent_rather_than_empty() {
        let json = serde_json::to_value(event_for(b"")).expect("serialises");

        // Not `""`. An adapter checking `body != null` would see a body on every GET, and some
        // frameworks then wait on a request stream that never ends.
        assert!(json.get("body").is_none());
        assert_eq!(json["isBase64Encoded"], false);
    }

    #[test]
    fn text_goes_as_text_and_bytes_go_as_base64() {
        let text = serde_json::to_value(event_for(b"{\"name\":\"ada\"}")).expect("serialises");
        assert_eq!(text["body"], "{\"name\":\"ada\"}");
        assert_eq!(text["isBase64Encoded"], false);

        // A truncated multi-byte sequence: not valid UTF-8, and the bytes must survive.
        let bytes = serde_json::to_value(event_for(&[0xff, 0xd8, 0xff, 0xe0])).expect("serialises");
        assert_eq!(bytes["isBase64Encoded"], true);
        assert_eq!(bytes["body"], BASE64.encode([0xff, 0xd8, 0xff, 0xe0]));
    }

    #[test]
    fn a_handler_that_returns_nothing_meant_two_hundred() {
        let reply: Reply = serde_json::from_str("{}").expect("deserialises");

        assert_eq!(status_of(&reply), 200);
        assert_eq!(decode_body(&reply).expect("decodes"), Vec::<u8>::new());
    }

    #[test]
    fn decodes_a_base64_reply_and_refuses_one_that_is_not() {
        let good: Reply =
            serde_json::from_str(r#"{"statusCode":200,"body":"//3/4A==","isBase64Encoded":true}"#)
                .expect("deserialises");
        assert_eq!(
            decode_body(&good).expect("decodes"),
            vec![0xff, 0xfd, 0xff, 0xe0]
        );

        // Claimed base64 that is not. Serving the raw text would render a broken image that looks
        // like the customer's own bug, so this is an error the router reports as its own.
        let bad: Reply = serde_json::from_str(r#"{"body":"not base64!!","isBase64Encoded":true}"#)
            .expect("deserialises");
        assert!(decode_body(&bad).is_err());
    }

    #[test]
    fn tolerates_a_reply_with_fields_we_do_not_know() {
        // Adapters add fields — `cookies`, `multiValueHeaders`. A strict shape would turn a working
        // customer app into a 502 from our own deserializer.
        let reply: Reply = serde_json::from_str(
            r#"{"statusCode":201,"headers":{"x-a":"b"},"cookies":["s=1"],"body":"ok"}"#,
        )
        .expect("deserialises");

        assert_eq!(status_of(&reply), 201);
        assert_eq!(reply.headers.get("x-a").map(String::as_str), Some("b"));
        assert_eq!(decode_body(&reply).expect("decodes"), b"ok".to_vec());
    }
}
