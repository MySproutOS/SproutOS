//! The router's producer against a real broker, and out the other side in ClickHouse.
//!
//! This test used to live in `log-extension`, because the extension used to hold the Kafka
//! connection. It does not any more — a credential in a customer's sandbox could forge another
//! tenant's `project_id` — so the producer, and this test with it, moved to the router.
//!
//! The property is unchanged and is the reason the test exists at all: the bytes this produces must
//! be bytes ClickHouse's `JSONEachRow` consumer accepts. A mismatch there is **silent**, because
//! `kafka_skip_broken_messages` is set on the consumer by design — one malformed record must not
//! wedge every tenant's logs. So nothing fails; the rows simply never arrive.

use router::log_kafka::KafkaProducer;
use router::logs::{IncomingRecord, ProduceBatch, stamp};

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
    // A test binary is its own process, and rustls picks its cipher suites per process. Without
    // this the first HTTPS call panics — so this test failed whenever Kafka was reachable, and
    // passed only by skipping.
    router::install_crypto_provider();

    if !kafka_up().await {
        // Keyed on "a job promised this service", not on "this is CI" — a different claim. Kafka
        // needs no token, so the workflow provides it and sets the flag; a skip here is therefore a
        // real silent skip and must fail.
        if std::env::var("REQUIRE_KAFKA").is_ok() {
            panic!("Kafka is not reachable, and REQUIRE_KAFKA says this job provides it");
        }
        eprintln!("skipping: no Kafka at {}", brokers());
        return;
    }

    /*
      A fresh project id per run, which the previous version of this test did not have.

      It used a fixed id and asserted an *absolute* count of two. `runtime_log` keeps rows for three
      days, so the second run of the day saw four, the third six, and the assertion could only ever
      pass once against a given ClickHouse — it read `left: 8` by the time anyone ran it again. The
      id was fixed "so the assertion can find exactly these rows", and unique ids serve that better:
      each run owns its own rows and cannot see anybody else's.

      Built from the clock rather than a UUID crate, because the column is a UUID and the only
      property needed is that two runs differ.
    */
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_nanos() as u64;
    let project_id = &format!("01a03800-0000-7000-8000-{:012x}", unique & 0xffff_ffff_ffff);
    let deployment_id = "01a03800-0000-7000-8000-00000000ext2";

    // The shape the extension posts: no project, because it has no say in one. `stamp` writes the
    // attribution, which is the boundary this whole path was rebuilt around.
    let incoming: Vec<IncomingRecord> = serde_json::from_str(
        r#"[
          {"ts":"2026-08-24 13:00:00.000","request_id":"8a2f4b1c-0000-4000-8000-00000000ffff",
           "level":"info","message":"from the extension"},
          {"ts":"2026-08-24 13:00:00.100","request_id":"8a2f4b1c-0000-4000-8000-00000000ffff",
           "level":"platform","message":"platform.report",
           "duration_ms":3.5,"billed_ms":4,"memory_mb":256,"init_ms":180.0,"cold_start":true}
        ]"#,
    )
    .expect("incoming records");

    let rows: Vec<_> = incoming
        .into_iter()
        .map(|record| stamp(record, project_id, deployment_id))
        .collect();
    assert_eq!(rows.len(), 2);

    unsafe {
        std::env::set_var("KAFKA_BROKERS", brokers());
    }

    let producer = KafkaProducer::connect().await.expect("a producer");
    producer.produce(&rows).await.expect("produce succeeds");

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
