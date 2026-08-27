//! The proxy, exercised end to end, with no model provider involved.
//!
//! ## Why a stub upstream rather than a real one
//!
//! The properties worth proving are all ours: that a sandbox token resolves to a session, that the
//! *customer's* credential reaches the provider and the sandbox's token does not, that tokens are
//! counted out of a streaming body, and that a signed usage batch arrives. None of those need a
//! real model, and running one would spend a customer's credential to test our own plumbing.
//!
//! It also means this test can run anywhere, which a test that needs an API key cannot — and a test
//! that only some people can run is a test that stops being run.
//!
//! ## What it does need
//!
//! A control-plane database, because the session lookup is a real query against a real table and
//! stubbing it would test a mock of the thing under test. Skipped with a message when
//! `DATABASE_URL` is unset rather than failing: a developer with no compose stack should not have a
//! red suite, but they should know why this one did not run.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::{any, post};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use sproutos_llm_proxy::serve::{ProxyState, handle};
use sproutos_llm_proxy::spool::{DeliveryConfig, MeteringSpool, SpoolLimits};
use sproutos_llm_proxy::store::{SessionStore, hex_sha256};

/// The key both halves share. Fixed here so the sealed value in the row is reproducible.
const PROXY_KEY: &[u8; 32] = b"0123456789abcdef0123456789abcdef";

/// What the customer's real credential is. The assertion that matters is that this reaches the
/// stub provider and the sandbox's token does not.
const UPSTREAM_SECRET: &str = "sk-ant-the-customers-real-key";

#[derive(Default)]
struct Captured {
    upstream_auth: Mutex<Option<String>>,
    batches: Mutex<Vec<String>>,
}

async fn stub_provider(
    State(captured): State<Arc<Captured>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    *captured.upstream_auth.lock().unwrap() = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // An Anthropic-shaped stream, split and delayed so the test can abandon after input while the
    // proxy continues draining the provider to terminal output usage.
    let first = concat!(
        "event: message_start\n",
        r#"data: {"type":"message_start","message":{"usage":{"input_tokens":41,"cache_read_input_tokens":7}}}"#,
        "\n\n",
    );
    let second = concat!(
        "event: message_delta\n",
        r#"data: {"type":"message_delta","usage":{"input_tokens":41,"output_tokens":58}}"#,
        "\n\ndata: [DONE]\n\n",
    );
    let stream = futures_util::stream::unfold(0_u8, move |part| async move {
        match part {
            0 => Some((Ok::<_, Infallible>(Bytes::from_static(first.as_bytes())), 1)),
            1 => {
                tokio::time::sleep(Duration::from_millis(75)).await;
                Some((Ok(Bytes::from_static(second.as_bytes())), 2))
            }
            _ => None,
        }
    });
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
}

async fn stub_ingest(State(captured): State<Arc<Captured>>, body: String) -> impl IntoResponse {
    captured.batches.lock().unwrap().push(body);
    "ok"
}

#[tokio::test]
async fn proxies_byo_usage_as_externally_charged_and_never_leaks_the_credential() {
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        eprintln!("DATABASE_URL is not set; skipping the LLM proxy end-to-end test");
        return;
    };

    let captured = Arc::new(Captured::default());

    // The provider, and the metering ingest, both ours and both stubs.
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_url = format!("http://{}", provider.local_addr().unwrap());
    let provider_app = Router::new()
        .fallback(any(stub_provider))
        .with_state(Arc::clone(&captured));
    tokio::spawn(async move { axum::serve(provider, provider_app).await.unwrap() });

    let ingest = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ingest_url = format!(
        "http://{}/v1/internal/metering/events",
        ingest.local_addr().unwrap()
    );
    let ingest_app = Router::new()
        .route("/v1/internal/metering/events", post(stub_ingest))
        .with_state(Arc::clone(&captured));
    tokio::spawn(async move { axum::serve(ingest, ingest_app).await.unwrap() });

    // The session, in the real table.
    let access_token = format!("spa_e2e_{}", std::process::id());
    let fixture = Fixture::create(&database_url, &access_token, &provider_url).await;

    let spool_dir = std::env::temp_dir().join(format!("sproutos-llm-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&spool_dir);
    let spool = MeteringSpool::open(&spool_dir, SpoolLimits::default()).unwrap();
    let delivery = spool.spawn_delivery(DeliveryConfig::new(
        reqwest::Client::new(),
        ingest_url,
        b"test-metering-key".to_vec(),
    ));
    let store = SessionStore::connect(
        &database_url,
        2,
        PROXY_KEY.to_vec(),
        Some("sk-platform-test-key".into()),
    )
    .unwrap();
    assert!(
        store
            .resolve(&access_token)
            .await
            .unwrap()
            .charged_externally,
        "an agent_credential_id must classify the session as externally charged"
    );
    assert!(
        !store
            .resolve(&fixture.platform_access_token)
            .await
            .unwrap()
            .charged_externally,
        "a null agent_credential_id must keep the platform-key session billable"
    );
    let state = Arc::new(ProxyState {
        store,
        http: reqwest::Client::builder().build().unwrap(),
        metering: Some(spool),
    });

    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}/v1/messages", proxy.local_addr().unwrap());
    let proxy_app = Router::new().fallback(any(handle)).with_state(state);
    tokio::spawn(async move { axum::serve(proxy, proxy_app).await.unwrap() });

    let response = reqwest::Client::new()
        .post(&proxy_url)
        .header("authorization", format!("Bearer {access_token}"))
        .header("content-type", "application/json")
        .body(r#"{"model":"claude-3","messages":[]}"#)
        .send()
        .await
        .expect("the proxy should answer");

    assert_eq!(response.status(), 200);
    let mut body = response.bytes_stream();
    let first = futures_util::StreamExt::next(&mut body)
        .await
        .expect("the provider should start the stream")
        .unwrap();
    // The first provider chunk reached the caller unchanged. Drop before terminal usage arrives:
    // the proxy must keep draining upstream, or output tokens become free on disconnect.
    assert!(
        String::from_utf8_lossy(&first).contains("message_start"),
        "the first body chunk was not forwarded: {}",
        String::from_utf8_lossy(&first)
    );
    drop(body);

    /*
      The credential swap, which is the reason this component exists.

      The provider must have seen the customer's key, and must never have seen the sandbox's token.
      If these ever invert, a sandbox holds a credential it can spend directly and we cannot rotate.
    */
    let seen = captured.upstream_auth.lock().unwrap().clone();
    assert_eq!(seen.as_deref(), Some(UPSTREAM_SECRET));
    assert!(
        !String::from_utf8_lossy(&first).contains(UPSTREAM_SECRET),
        "the upstream key was echoed to the caller"
    );

    // Billing is durably spooled on drop, then delivered in the background just after the response.
    let mut batches = Vec::new();
    for _ in 0..40 {
        batches = captured.batches.lock().unwrap().clone();
        if !batches.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let batch = batches
        .first()
        .expect("a usage batch should have been posted");
    let parsed: serde_json::Value = serde_json::from_str(batch).unwrap();
    let events = parsed["events"].as_array().expect("events");

    // Three dimensions, one per non-zero count, each carrying what the stream reported.
    let quantity = |dimension: &str| {
        events
            .iter()
            .find(|event| event["dimension"] == dimension)
            .map(|event| event["quantity"].as_f64().unwrap())
    };
    assert_eq!(quantity("ai_input_token"), Some(41.0));
    assert_eq!(
        quantity("ai_output_token"),
        Some(58.0),
        "terminal usage must still be counted after the downstream disconnects"
    );
    assert_eq!(quantity("ai_cache_read_token"), Some(7.0));
    assert!(
        events
            .iter()
            .all(|event| event["charged_externally"] == true),
        "a customer credential must keep usage visible without making SproutOS charge for it: {batch}"
    );

    // The sandbox's token must not appear in the ledger either — it is a credential, and
    // `audit_log` and the usage tables are both places a secret cannot be deleted from.
    assert!(!batch.contains(&access_token));
    assert!(!batch.contains(UPSTREAM_SECRET));

    fixture.clean(&database_url).await;
    delivery.abort();
    let _ = std::fs::remove_dir_all(spool_dir);
}

/// The rows this test needs, and their removal.
struct Fixture {
    user_id: String,
    organization_id: String,
    credential_id: String,
    token_id: String,
    platform_token_id: String,
    platform_access_token: String,
}

impl Fixture {
    async fn create(database_url: &str, access_token: &str, provider_url: &str) -> Self {
        let client = connect(database_url).await;

        let user_id = uuid();
        let organization_id = uuid();
        let credential_id = uuid();
        let token_id = uuid();
        let platform_token_id = uuid();
        let platform_access_token = format!("spa_platform_e2e_{}", std::process::id());

        client
            .execute(
                "insert into \"user\" (id, email) values ($1::text::uuid, $2)",
                &[
                    &user_id,
                    &format!("llm-proxy-e2e-{user_id}@example.invalid"),
                ],
            )
            .await
            .expect("seeding a user");
        client
            .execute(
                "insert into organization (id, slug, name, kind, owner_user_id) \
                 values ($1::text::uuid, $2, $3, 'personal', $4::text::uuid)",
                &[
                    &organization_id,
                    &format!("llm-proxy-e2e-{organization_id}"),
                    &"LLM proxy end to end",
                    &user_id,
                ],
            )
            .await
            .expect("seeding an organization");

        client
            .execute(
                "insert into agent_credential \
                 (id, organization_id, kind, label, secret_ciphertext, secret_wrapped_dek, secret_kms_key_id) \
                 values ($1::text::uuid, $2::text::uuid, 'anthropic_api_key', $3, $4, $5, $6)",
                &[
                    &credential_id,
                    &organization_id,
                    &format!("llm-proxy-e2e-{credential_id}"),
                    &"unused-in-proxy-test",
                    &"unused-in-proxy-test",
                    &"unused-in-proxy-test",
                ],
            )
            .await
            .expect("seeding an agent credential");

        let sealed = seal(UPSTREAM_SECRET);
        client
            .execute(
                "insert into agent_proxy_token \
                 (id, organization_id, access_token_hash, refresh_token_hash, \
                  access_expires_at, refresh_expires_at, agent_credential_id, upstream_kind, \
                  upstream_base_url, upstream_secret) \
                 values ($1::text::uuid, $2::text::uuid, $3, $4, now() + interval '10 minutes', \
                         now() + interval '1 hour', $5::text::uuid, 'anthropic', $6, $7)",
                &[
                    &token_id,
                    &organization_id,
                    &hex_sha256(access_token),
                    &hex_sha256(&format!("refresh-{access_token}")),
                    &credential_id,
                    &provider_url,
                    &sealed,
                ],
            )
            .await
            .expect("seeding a proxy token");

        client
            .execute(
                "insert into agent_proxy_token \
                 (id, organization_id, access_token_hash, refresh_token_hash, \
                  access_expires_at, refresh_expires_at) \
                 values ($1::text::uuid, $2::text::uuid, $3, $4, now() + interval '10 minutes', \
                         now() + interval '1 hour')",
                &[
                    &platform_token_id,
                    &organization_id,
                    &hex_sha256(&platform_access_token),
                    &hex_sha256(&format!("refresh-{platform_access_token}")),
                ],
            )
            .await
            .expect("seeding a platform-key proxy token");

        Self {
            user_id,
            organization_id,
            credential_id,
            token_id,
            platform_token_id,
            platform_access_token,
        }
    }

    async fn clean(&self, database_url: &str) {
        let client = connect(database_url).await;
        for (table, id) in [
            ("agent_proxy_token", &self.token_id),
            ("agent_proxy_token", &self.platform_token_id),
            ("agent_credential", &self.credential_id),
            ("organization", &self.organization_id),
            ("\"user\"", &self.user_id),
        ] {
            let _ = client
                .execute(
                    &format!("delete from {table} where id = $1::text::uuid"),
                    &[id as &(dyn tokio_postgres::types::ToSql + Sync)],
                )
                .await;
        }
    }
}

async fn connect(database_url: &str) -> tokio_postgres::Client {
    /*
      Plain TCP, and the URL normalised first.

      This is the local compose Postgres, which does not force TLS — the production path goes
      through `SessionStore`, which does. `normalise_url` is the same function that path uses: a
      Prisma-style `?schema=public` is in the repo's own `DATABASE_URL` and `tokio_postgres` refuses
      it outright with `UnknownOption("schema")`, which is a confusing way to learn your database is
      reachable.
    */
    let normalised = sproutos_service_credentials::normalise_url(database_url);
    let (client, connection) = tokio_postgres::connect(&normalised, tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

/// Seal a value the way `@lib/proxy-secret` does, so the row is what the control plane would write.
fn seal(plaintext: &str) -> String {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let nonce = [7u8; 12];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(PROXY_KEY));
    let body = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: &[],
            },
        )
        .unwrap();

    let mut out = nonce.to_vec();
    out.extend_from_slice(&body);
    BASE64.encode(out)
}

fn uuid() -> String {
    // A v4-shaped value from the process id and a counter, so the test needs no uuid crate and
    // still produces something unique per run.
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let p = std::process::id();
    format!("{p:08x}-0000-4000-8000-{n:012x}")
}
