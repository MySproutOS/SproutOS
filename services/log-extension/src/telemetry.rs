//! Turning Lambda's Telemetry API records into rows for ClickHouse.
//!
//! **This is not the CloudWatch text format.** A subscription filter delivers the same lines a
//! human sees — `REPORT RequestId: … Billed Duration: 2 ms` — and getting the billing numbers out
//! means parsing prose. The Telemetry API delivers the same information as JSON, with the metrics
//! already broken out, which is the strongest practical argument for the extension: there is no
//! regex between the platform and the number a customer is charged from.

use serde::Deserialize;

/// One record as the Telemetry API delivers it.
#[derive(Debug, Deserialize)]
pub struct TelemetryEvent {
    pub time: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub record: serde_json::Value,
}

/// What goes on the Kafka topic. Snake case, because ClickHouse's `JSONEachRow` matches column
/// names exactly and a camelCase key is a column it silently ignores.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct LogRow {
    pub ts: String,
    pub project_id: String,
    pub deployment_id: String,
    pub request_id: String,
    pub level: String,
    pub message: String,
    pub duration_ms: Option<f32>,
    pub billed_ms: Option<u32>,
    pub memory_mb: Option<u16>,
    pub init_ms: Option<f32>,
    pub cold_start: Option<bool>,
}

/// `2026-08-24T12:00:00.123Z` to `2026-08-24 12:00:00.123`.
///
/// ClickHouse's `DateTime64(3)` does not parse the `T` or the `Z`, and a row whose timestamp will
/// not parse is dropped by the consumer — with `kafka_skip_broken_messages` on, silently.
pub fn clickhouse_time(rfc3339: &str) -> String {
    rfc3339.replace('T', " ").trim_end_matches('Z').to_owned()
}

/// The level a record is at.
///
/// Lambda's own records — `platform.start`, `platform.report`, `platform.initReport` — are
/// `platform`, so a customer filtering for `info` is not shown the runtime's bookkeeping. A
/// `function` record carries the level the customer's own logger set, when it set one.
pub fn level_of(event: &TelemetryEvent) -> String {
    if event.kind.starts_with("platform") {
        return "platform".to_owned();
    }

    match event.record.get("level").and_then(|value| value.as_str()) {
        Some(level) => match level.to_ascii_lowercase().as_str() {
            "warning" => "warn".to_owned(),
            "critical" => "fatal".to_owned(),
            other => other.to_owned(),
        },
        // A record with no level is still a line the customer wants. Dropping it, or filing it
        // under `error`, would both be worse than calling it `info`.
        None => "info".to_owned(),
    }
}

/// The text of a record.
///
/// A `function` record is either a bare string or an object with a `message`, depending on whether
/// the customer's logger emits structured JSON. Both are kept as text: a log viewer shows lines.
pub fn message_of(event: &TelemetryEvent) -> String {
    if let Some(text) = event.record.as_str() {
        return text.trim_end().to_owned();
    }
    if let Some(text) = event.record.get("message").and_then(|value| value.as_str()) {
        return text.trim_end().to_owned();
    }
    event.record.to_string()
}

fn request_id_of(event: &TelemetryEvent) -> String {
    event
        .record
        .get("requestId")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Turn one record into a row.
///
/// Returns `None` for record types that carry nothing worth storing — `platform.extension`,
/// `platform.telemetrySubscription` and the like are this extension talking about itself.
pub fn to_row(event: &TelemetryEvent, project_id: &str, deployment_id: &str) -> Option<LogRow> {
    if event.kind != "function"
        && event.kind != "platform.report"
        && event.kind != "platform.start"
        && event.kind != "platform.initRuntimeDone"
    {
        return None;
    }

    let mut row = LogRow {
        ts: clickhouse_time(&event.time),
        project_id: project_id.to_owned(),
        deployment_id: deployment_id.to_owned(),
        request_id: request_id_of(event),
        level: level_of(event),
        message: message_of(event),
        duration_ms: None,
        billed_ms: None,
        memory_mb: None,
        init_ms: None,
        cold_start: None,
    };

    if event.kind == "platform.report" {
        let metrics = event.record.get("metrics");
        let number = |name: &str| metrics.and_then(|m| m.get(name)).and_then(|v| v.as_f64());

        row.duration_ms = number("durationMs").map(|value| value as f32);
        /*
          `billedDurationMs`, never `durationMs`.

          They differ, and on a cold start the billed figure includes the init that the measured one
          excludes. Billing the measured value would absorb every cold start's initialisation as
          platform cost — invisibly, and in exact proportion to how many new customers arrive.
        */
        row.billed_ms = number("billedDurationMs").map(|value| value as u32);
        row.memory_mb = number("memorySizeMB").map(|value| value as u16);

        let init = number("initDurationMs").map(|value| value as f32);
        row.init_ms = init;
        // There is no boolean for this anywhere in the payload: the presence of an init duration is
        // the signal. `false` rather than `None` — "not a cold start" is a fact, and a null reads as
        // "we do not know" in a ratio nobody could then trust.
        row.cold_start = Some(init.is_some());
    }

    Some(row)
}

/// One `JSONEachRow` line per row, which is what the Kafka topic carries.
pub fn encode_batch(rows: &[LogRow]) -> Vec<Vec<u8>> {
    rows.iter()
        .filter_map(|row| serde_json::to_vec(row).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "01a03600-0000-7000-8000-00000000d1ce";
    const DEPLOYMENT: &str = "01a03600-0000-7000-8000-0000000000de";

    fn parse(json: &str) -> TelemetryEvent {
        serde_json::from_str(json).expect("a telemetry record")
    }

    #[test]
    fn reads_the_billing_metrics_without_a_regex() {
        /*
          The whole argument for the extension over CloudWatch, in one test.

          A subscription filter delivers `REPORT RequestId: … Billed Duration: 2 ms` and the number
          a customer is charged from has to be pulled out of prose. Here it is a field.
        */
        let event = parse(
            r#"{"time":"2026-08-24T12:00:00.123Z","type":"platform.report","record":{
                "requestId":"8a2f4b1c-0000-4000-8000-00000000abcd",
                "metrics":{"durationMs":1.23,"billedDurationMs":220,"memorySizeMB":512,
                           "maxMemoryUsedMB":78,"initDurationMs":210.5}}}"#,
        );

        let row = to_row(&event, PROJECT, DEPLOYMENT).expect("a row");

        assert_eq!(row.billed_ms, Some(220));
        assert_eq!(row.memory_mb, Some(512));
        assert_eq!(row.init_ms, Some(210.5));
        assert_eq!(row.cold_start, Some(true));
        assert_eq!(row.request_id, "8a2f4b1c-0000-4000-8000-00000000abcd");
        assert_eq!(row.level, "platform");
    }

    #[test]
    fn bills_the_rounded_duration_and_not_the_measured_one() {
        let event = parse(
            r#"{"time":"2026-08-24T12:00:00.000Z","type":"platform.report","record":{
                "requestId":"r","metrics":{"durationMs":1.23,"billedDurationMs":220,
                "memorySizeMB":512}}}"#,
        );

        let row = to_row(&event, PROJECT, DEPLOYMENT).expect("a row");

        // 220, not 1. The difference is the init on a cold start, and billing the smaller number
        // means the platform absorbs it.
        assert_eq!(row.billed_ms, Some(220));
        assert_eq!(row.duration_ms, Some(1.23));
    }

    #[test]
    fn calls_a_warm_invocation_warm() {
        let event = parse(
            r#"{"time":"2026-08-24T12:00:00.000Z","type":"platform.report","record":{
                "requestId":"r","metrics":{"durationMs":0.9,"billedDurationMs":1,
                "memorySizeMB":128}}}"#,
        );

        let row = to_row(&event, PROJECT, DEPLOYMENT).expect("a row");

        assert_eq!(row.init_ms, None);
        assert_eq!(row.cold_start, Some(false));
    }

    #[test]
    fn takes_a_customer_line_whether_it_is_a_string_or_an_object() {
        let bare = parse(
            r#"{"time":"2026-08-24T12:00:00.000Z","type":"function","record":"plain output\n"}"#,
        );
        assert_eq!(message_of(&bare), "plain output");
        assert_eq!(level_of(&bare), "info");

        // A structured logger. The level comes from the record, not from scanning the text.
        let structured = parse(
            r#"{"time":"2026-08-24T12:00:00.000Z","type":"function","record":{
                "level":"ERROR","message":"the upstream refused",
                "requestId":"8a2f4b1c-0000-4000-8000-00000000abcd"}}"#,
        );
        assert_eq!(message_of(&structured), "the upstream refused");
        assert_eq!(level_of(&structured), "error");
        assert_eq!(
            to_row(&structured, PROJECT, DEPLOYMENT)
                .expect("a row")
                .request_id,
            "8a2f4b1c-0000-4000-8000-00000000abcd"
        );
    }

    #[test]
    fn drops_the_records_that_are_this_extension_talking_about_itself() {
        for kind in [
            "platform.extension",
            "platform.telemetrySubscription",
            "platform.logsDropped",
        ] {
            let event = parse(&format!(
                r#"{{"time":"2026-08-24T12:00:00.000Z","type":"{kind}","record":{{}}}}"#
            ));
            assert!(
                to_row(&event, PROJECT, DEPLOYMENT).is_none(),
                "{kind} should not be stored"
            );
        }
    }

    #[test]
    fn writes_a_timestamp_clickhouse_can_parse() {
        // `DateTime64(3)` does not take the `T` or the `Z`, and a row whose timestamp will not
        // parse is dropped by the consumer — silently, because broken messages are skipped.
        assert_eq!(
            clickhouse_time("2026-08-24T12:00:00.123Z"),
            "2026-08-24 12:00:00.123"
        );
    }

    #[test]
    fn encodes_one_json_line_per_row() {
        let event =
            parse(r#"{"time":"2026-08-24T12:00:00.000Z","type":"function","record":"hello"}"#);
        let rows = vec![to_row(&event, PROJECT, DEPLOYMENT).expect("a row")];

        let encoded = encode_batch(&rows);
        assert_eq!(encoded.len(), 1);

        let value: serde_json::Value = serde_json::from_slice(&encoded[0]).expect("json");
        // Snake case: `JSONEachRow` matches column names exactly, so `projectId` would be a column
        // ClickHouse ignores and the row would arrive with an empty project.
        assert!(value.get("project_id").is_some());
        assert!(value.get("projectId").is_none());
        assert!(value.get("cold_start").is_some());
    }
}
