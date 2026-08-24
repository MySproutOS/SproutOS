//! The extension's producer against a real broker, and out the other side in ClickHouse.
//!
//! The parsing is unit-tested and pure. What only a real broker can show is that the bytes this
//! produces are bytes ClickHouse's `JSONEachRow` consumer accepts — a mismatch there is silent,
//! because broken messages are skipped by design.

use log_extension::kafka;
use log_extension::telemetry::{TelemetryEvent, encode_batch, to_row};

fn brokers() -> String {
    std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:29092".into())
}

async fn kafka_up() -> bool {
    tokio::net::TcpStream::connect(brokers().replace("localhost", "127.0.0.1"))
        .await
        .is_ok()
}

#[tokio::test]
async fn produces_rows_clickhouse_accepts() {
    if !kafka_up().await {
        if std::env::var("CI").is_ok() {
            panic!("Kafka is not reachable in CI; this test must not skip here");
        }
        eprintln!("skipping: no Kafka at {}", brokers());
        return;
    }

    // Deterministic, so the assertion below can find exactly these rows.
    let project_id = "01a03800-0000-7000-8000-00000000ext1";
    let deployment_id = "01a03800-0000-7000-8000-00000000ext2";

    let events: Vec<TelemetryEvent> = serde_json::from_str(
        r#"[
          {"time":"2026-08-24T13:00:00.000Z","type":"function","record":"from the extension"},
          {"time":"2026-08-24T13:00:00.100Z","type":"platform.report","record":{
             "requestId":"8a2f4b1c-0000-4000-8000-00000000ffff",
             "metrics":{"durationMs":3.5,"billedDurationMs":4,"memorySizeMB":256,
                        "initDurationMs":180.0}}}
        ]"#,
    )
    .expect("telemetry records");

    let rows: Vec<_> = events
        .iter()
        .filter_map(|event| to_row(event, project_id, deployment_id))
        .collect();
    assert_eq!(rows.len(), 2);

    unsafe {
        std::env::set_var("KAFKA_BROKERS", brokers());
        std::env::set_var("SPROUTOS_PROJECT_ID", project_id);
    }

    let producer = kafka::connect().await.expect("a producer");
    producer
        .send(&encode_batch(&rows))
        .await
        .expect("produce succeeds");

    // Read back through ClickHouse's HTTP interface rather than a client library: the point is that
    // the consumer accepted these bytes, and the fewest layers between the assertion and that fact
    // is the most convincing form of it.
    let url = std::env::var("CLICKHOUSE_URL").unwrap_or_else(|_| "http://localhost:28123".into());
    let user = std::env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "sproutos".into());
    let password = std::env::var("CLICKHOUSE_PASSWORD").unwrap_or_else(|_| "sproutos".into());
    let client = reqwest::Client::new();

    let mut found = 0;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let response = client
            .post(&url)
            .basic_auth(&user, Some(&password))
            .body(format!(
                "select count() from observability.runtime_log where project_id = '{project_id}'"
            ))
            .send()
            .await
            .expect("clickhouse answers");
        let body = response.text().await.unwrap_or_default();
        found = body.trim().parse::<i64>().unwrap_or(0);
        if found >= 2 {
            break;
        }
    }

    assert_eq!(
        found, 2,
        "the consumer did not accept what the extension produced"
    );

    // The billing field specifically. A null here is money the platform silently does not collect.
    let response = client
        .post(&url)
        .basic_auth(&user, Some(&password))
        .body(format!(
            "select billed_ms, memory_mb, cold_start from observability.runtime_log \
             where project_id = '{project_id}' and billed_ms is not null"
        ))
        .send()
        .await
        .expect("clickhouse answers");
    let row = response.text().await.unwrap_or_default();
    assert_eq!(row.trim(), "4\t256\ttrue");

    let _ = client
        .post(&url)
        .basic_auth(&user, Some(&password))
        .body(format!(
            "alter table observability.runtime_log delete where project_id = '{project_id}'"
        ))
        .send()
        .await;
}
