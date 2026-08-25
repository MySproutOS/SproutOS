//! Registering with Lambda, subscribing to telemetry, and the loop in between.
//!
//! The shapes here are the Extensions API's, and the sequence is not negotiable: register first,
//! *then* subscribe, then call `/next` forever. Subscribing before registering is rejected with a
//! message about an unknown extension identifier, which reads like a bug in the identifier.

use std::net::SocketAddr;

use anyhow::Context as _;
use serde::Deserialize;

/// The header Lambda answers `register` with, and expects on every later call.
pub const EXTENSION_ID_HEADER: &str = "Lambda-Extension-Identifier";

/// Where this extension listens for telemetry batches.
///
/// `sandbox.localdomain` rather than `127.0.0.1`, because that is the name Lambda resolves inside
/// the execution environment and the only address the Telemetry API will deliver to.
pub const LISTENER_HOST: &str = "sandbox.localdomain";
pub const LISTENER_PORT: u16 = 4243;

pub fn listener_addr() -> SocketAddr {
    // Bound on all interfaces: the delivery arrives addressed to `sandbox.localdomain`, which does
    // not resolve to loopback in every runtime image. Binding loopback only is a subscription that
    // succeeds and then delivers nothing.
    SocketAddr::from(([0, 0, 0, 0], LISTENER_PORT))
}

#[derive(Debug, Deserialize)]
pub struct NextEvent {
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(rename = "requestId", default)]
    pub request_id: Option<String>,
}

/// The subscription body.
///
/// `platform` and `function` only — `extension` records are this extension describing itself, and
/// subscribing to them is a feedback loop that produces a record about producing a record.
///
/// The buffering knobs matter more than they look. Lambda holds telemetry until one of them trips,
/// and the defaults favour throughput over latency; a log viewer that polls once a second wants the
/// timeout low. `max_bytes` is bounded because the whole batch arrives in one POST into this
/// extension's own memory, which is the customer's memory.
pub fn subscription_body() -> serde_json::Value {
    /*
      Exactly four fields, and no fifth.

      The Telemetry API validates this body strictly and rejects an unknown key rather than
      ignoring it:

          400 {"errorType":"Telemetry.DeserializationError",
               "errorMessage":"unknown field `extensionName`, expected one of `schemaVersion`,
                               `types`, `buffering`, `destination`"}

      An `extensionName` was here, which looks reasonable — the extension does have to identify
      itself. It identifies itself in the `Lambda-Extension-Identifier` *header*, which `subscribe`
      already sends; naming itself again in the body is the API's definition of malformed.

      The consequence was not a failed subscription but a failed *function*: the extension exits
      non-zero, Lambda reports `Extension.Crash`, and every invocation of the customer's code fails
      with it. An extension is inside the customer's execution environment, so its bugs are theirs.
    */
    serde_json::json!({
        "schemaVersion": "2022-12-13",
        "types": ["platform", "function"],
        "buffering": { "timeoutMs": 1000, "maxBytes": 262_144, "maxItems": 1000 },
        "destination": {
            "protocol": "HTTP",
            "URI": format!("http://{LISTENER_HOST}:{LISTENER_PORT}"),
        },
    })
}

/// The base URL of the Extensions API, from the environment Lambda provides.
pub fn api_base() -> anyhow::Result<String> {
    let host = std::env::var("AWS_LAMBDA_RUNTIME_API")
        .context("AWS_LAMBDA_RUNTIME_API is not set; this is not running as a Lambda extension")?;
    Ok(format!("http://{host}"))
}

/// Register, and return the identifier every later call must carry.
pub async fn register(client: &reqwest::Client, base: &str) -> anyhow::Result<String> {
    let response = client
        .post(format!("{base}/2020-01-01/extension/register"))
        .header("Lambda-Extension-Name", extension_name()?)
        /*
          `INVOKE` as well as `SHUTDOWN`, and not because this extension wants to know a request
          started — the telemetry says so.
          It is subscribed to because **`/next` is the only thing that thaws this process.** The
          execution environment is frozen between invocations, so an extension registered for
          `SHUTDOWN` alone blocks in `/next` for the entire life of the sandbox: telemetry arrives
          at the listener and fills the channel, and nothing drains it until the environment dies.
          Logs then appear minutes late, in one burst, inside whatever grace period Lambda grants a
          shutdown — and not at all if that period ends first.
          Registered for `INVOKE`, `/next` returns once per invocation, the loop drains what the
          previous one produced, and a line is in ClickHouse seconds after it is written.
          The cost is real and is the reason the loop drains *before* calling `/next` rather than
          after: Lambda holds an invocation open until every `INVOKE`-registered extension has asked
          for the next event, so time spent here is time on the customer's bill. Draining first
          means the produce that delays invocation N carries invocation N-1's lines, and a function
          that is never called again leaves its last lines to the shutdown path below.
        */
        .json(&serde_json::json!({ "events": ["INVOKE", "SHUTDOWN"] }))
        .send()
        .await
        .context("could not reach the Extensions API")?;

    let id = response
        .headers()
        .get(EXTENSION_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .context("register returned no extension identifier")?
        .to_owned();

    Ok(id)
}

/// The file name Lambda knows this extension by.
///
/// Must match the executable's name in `/opt/extensions/`, exactly. A mismatch is rejected at
/// registration with a message that does not say which of the two names was wrong.
pub fn extension_name() -> anyhow::Result<String> {
    let path = std::env::current_exe().context("could not read this executable's own path")?;
    Ok(path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("log-extension")
        .to_owned())
}

/// Subscribe to telemetry. Must come after `register`.
pub async fn subscribe(
    client: &reqwest::Client,
    base: &str,
    extension_id: &str,
) -> anyhow::Result<()> {
    let response = client
        .put(format!("{base}/2022-07-01/telemetry"))
        .header(EXTENSION_ID_HEADER, extension_id)
        .json(&subscription_body())
        .send()
        .await
        .context("could not subscribe to the Telemetry API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("telemetry subscription refused: {status} {body}");
    }

    Ok(())
}

/// Block until Lambda has something to say.
///
/// **This is also how the extension yields.** The environment is frozen between invocations and
/// thaws when `/next` returns, so anything this process wants to do — flushing a producer, say —
/// happens either before calling it or not at all. Work started and left running does not continue
/// while frozen; it resumes minutes later in an environment that has moved on.
pub async fn next(
    client: &reqwest::Client,
    base: &str,
    extension_id: &str,
) -> anyhow::Result<NextEvent> {
    let response = client
        .get(format!("{base}/2020-01-01/extension/event/next"))
        .header(EXTENSION_ID_HEADER, extension_id)
        .send()
        .await
        .context("the Extensions API stopped answering")?;

    response
        .json()
        .await
        .context("could not read the next event")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribes_to_the_customers_logs_and_not_to_its_own() {
        let body = subscription_body();
        let types = body["types"].as_array().expect("types");

        assert!(types.iter().any(|value| value == "function"));
        assert!(types.iter().any(|value| value == "platform"));
        // `extension` records are this extension describing itself. Subscribing would produce a
        // record about producing a record, forever.
        assert!(!types.iter().any(|value| value == "extension"));
    }

    #[test]
    fn asks_for_delivery_at_the_name_lambda_resolves() {
        let body = subscription_body();

        // `sandbox.localdomain`, not `127.0.0.1`: it is the name the Telemetry API delivers to, and
        // a URI naming loopback is a subscription that succeeds and then delivers nothing.
        assert_eq!(
            body["destination"]["URI"].as_str(),
            Some("http://sandbox.localdomain:4243")
        );
    }

    /// The Telemetry API rejects an unknown key rather than ignoring it, and the rejection fails
    /// the customer's function rather than just the subscription. Every one of the other tests here
    /// passed while an `extensionName` in this body made every invocation `Extension.Crash` — they
    /// each asserted that something they wanted was present, and nothing asserted that nothing else
    /// was. This is that assertion.
    #[test]
    fn carries_no_field_the_api_does_not_accept() {
        let body = subscription_body();
        let object = body.as_object().expect("an object");

        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();

        assert_eq!(
            keys,
            ["buffering", "destination", "schemaVersion", "types"],
            "the API accepts exactly these four and 400s on anything else"
        );
    }

    #[test]
    fn keeps_the_buffer_small_because_it_is_the_customers_memory() {
        let body = subscription_body();

        // The batch arrives in one POST into this process, inside the customer's memory limit.
        assert_eq!(body["buffering"]["maxBytes"].as_u64(), Some(262_144));
        // A log viewer polls once a second; a longer timeout is latency nobody asked for.
        assert_eq!(body["buffering"]["timeoutMs"].as_u64(), Some(1000));
    }

    #[test]
    fn listens_on_every_interface() {
        // Delivery is addressed to `sandbox.localdomain`, which does not resolve to loopback in
        // every runtime image.
        assert_eq!(listener_addr().ip().to_string(), "0.0.0.0");
        assert_eq!(listener_addr().port(), LISTENER_PORT);
    }
}
