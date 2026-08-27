//! End to end: a real client, through the proxy, to the OpenSearch in docker-compose.
//!
//! The unit tests prove each piece in isolation. None of them prove the pieces are wired to each
//! other, and the failure this service exists to prevent is a wiring failure — one tenant reading
//! another's index. So this provisions two tenants, has both create an index of the *same name*,
//! and checks that neither can see the other's documents. It checks it from **outside the proxy**,
//! by asking OpenSearch directly what indices exist.
//!
//! Skipped, not failed, when the services are not running — except in CI, where a skip would look
//! exactly like a pass.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use search_proxy::metering::SearchMeter;
use search_proxy::naming::prefix_for;
use search_proxy::security::{SecurityManager, TenantSecurityIdentity};
use search_proxy::{Proxy, handle};
use sproutos_llm_proxy::spool::{MeteringSpool, SpoolLimits};
use sproutos_metering_proto::{UsageBatch, UsageDimension};
use sproutos_service_credentials::CredentialStore;
use sproutos_tenant_auth::{ResourceKind, TenantIdentity, generate_secret, hash_generated_secret};
use uuid::Uuid;

// Security-plugin configuration writes are cluster-global. The real router shares one manager and
// serializes them; these tests each start their own proxy, so serialize the test cases as well.
static INTEGRATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn upstream() -> String {
    std::env::var("SEARCH_PROXY_UPSTREAM").unwrap_or_else(|_| "http://127.0.0.1:29200".into())
}

fn database_url() -> Option<String> {
    std::env::var("SEARCH_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .map(|url| url.split('?').next().unwrap_or(&url).to_owned())
}

async fn services_up(url: &str) -> bool {
    let search = reqwest::Client::new()
        .get(upstream())
        .send()
        .await
        // A secured cluster answers an unauthenticated request with 401. That is healthy and is
        // itself one of the properties this suite verifies.
        .map(|response| !response.status().is_server_error())
        .unwrap_or(false);
    let postgres = match CredentialStore::connect(url, 2) {
        Ok(store) => store.check().await.is_ok(),
        Err(_) => false,
    };

    /*
      On a developer's machine a missing service is a skip: `cargo test` should not fail because
      docker is not running. In CI it is a failure — a skipped isolation test looks exactly like a
      passing one in the summary, so a workflow that lost a service container would go on reporting
      green while the tests that check tenants cannot read each other stopped running.
    */
    if (!search || !postgres) && std::env::var("CI").is_ok() {
        panic!(
            "the integration services are not reachable in CI (search={search}, postgres={postgres})"
        );
    }
    if !search || !postgres {
        eprintln!("skipping: run `docker compose up -d` and apply migrations first");
    }
    search && postgres
}

/// Starts the proxy on an ephemeral port.
async fn start_proxy(url: &str) -> SocketAddr {
    start_proxy_at(url, upstream()).await
}

async fn start_proxy_at(url: &str, upstream: String) -> SocketAddr {
    start_proxy_metered(url, upstream, None).await
}

async fn start_proxy_metered(
    url: &str,
    upstream: String,
    metering: Option<SearchMeter>,
) -> SocketAddr {
    let store = Arc::new(CredentialStore::connect(url, 4).expect("credential store"));
    let client = reqwest::Client::new();
    let security = SecurityManager::new(
        client.clone(),
        upstream.clone(),
        std::env::var("SEARCH_PROXY_SECURITY_ROOT_KEY")
            .unwrap_or_else(|_| "local-search-security-root-key-32-bytes".into()),
    )
    .expect("security manager");
    let proxy = Arc::new(Proxy {
        store,
        upstream,
        client,
        security,
        metering,
    });

    let app = axum::Router::new()
        .fallback(axum::routing::any(handle))
        .with_state(proxy);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    address
}

#[tokio::test]
async fn successful_queries_and_engine_owned_storage_are_durably_metered() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let spool_path = std::env::temp_dir().join(format!("search-meter-e2e-{}", Uuid::now_v7()));
    let spool = MeteringSpool::open(&spool_path, SpoolLimits::default()).unwrap();
    let meter = SearchMeter::new(spool.clone());
    let upstream = upstream();
    let address = start_proxy_metered(&url, upstream.clone(), Some(meter.clone())).await;
    let tenant = provision(&url).await;
    let index = unique_index("metered");

    let (status, _) = as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        &format!("/{index}/_search"),
        Some(("application/json", r#"{"query":{"match_all":{}}}"#.into())),
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(
        spool.pending_records(),
        0,
        "a rejected query did not execute"
    );

    let (status, body) = as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some(("application/json", r#"{"value":"owned"}"#.into())),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {body}");
    assert_eq!(spool.pending_records(), 0, "index writes are not queries");

    let (status, body) = as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        &format!("/{index}/_search"),
        Some(("application/json", r#"{"query":{"match_all":{}}}"#.into())),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(spool.pending_records(), 1);

    let client = reqwest::Client::new();
    let security = SecurityManager::new(
        client.clone(),
        upstream.clone(),
        std::env::var("SEARCH_PROXY_SECURITY_ROOT_KEY")
            .unwrap_or_else(|_| "local-search-security-root-key-32-bytes".into()),
    )
    .unwrap();
    meter
        .sample_storage_at(&security, &client, &upstream, 1_723_460_400_000)
        .await;

    let batches: Vec<UsageBatch> = std::fs::read_dir(&spool_path)
        .unwrap()
        .map(|entry| {
            serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
        })
        .collect();
    assert!(batches.iter().flat_map(|batch| &batch.events).any(|event| {
        event.organization_id == tenant.identity.organization_id
            && event.dimension == UsageDimension::EsSearchUnit
            && event.quantity == 1.0
    }));
    assert!(batches.iter().flat_map(|batch| &batch.events).any(|event| {
        event.organization_id == tenant.identity.organization_id
            && event.dimension == UsageDimension::EsStorageGibHour
            && event.quantity > 0.0
            && event.occurred_at == 1_723_460_400_000
    }));

    cleanup(&url, &[&tenant]).await;
    std::fs::remove_dir_all(spool_path).unwrap();
}

struct Tenant {
    username: String,
    secret: String,
    identity: TenantIdentity,
    fixtures: Vec<Uuid>,
}

/// Provisions a tenant in the control-plane database.
async fn provision(url: &str) -> Tenant {
    provision_kind(url, ResourceKind::SearchIndex).await
}

async fn provision_kind(url: &str, resource_kind: ResourceKind) -> Tenant {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect to postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let user_id = Uuid::now_v7();
    let organization_id = Uuid::now_v7();
    let service_id = Uuid::now_v7();

    client
        .execute(
            "insert into \"user\" (id, email, name) values ($1, $2, 'Search Test')",
            &[&user_id, &format!("search-{user_id}@test.invalid")],
        )
        .await
        .expect("insert user");
    client
        .execute(
            "insert into organization (id, name, slug, kind, owner_user_id)
             values ($1, 'Search Org', $2, 'personal', $3)",
            &[
                &organization_id,
                &format!("search-{organization_id}"),
                &user_id,
            ],
        )
        .await
        .expect("insert organization");

    let region: Uuid = client
        .query_one("select id from region limit 1", &[])
        .await
        .expect("a seeded region")
        .get(0);

    client
        .execute(
            "insert into backend_service (id, organization_id, region_id, name, kind, status)
             values ($1, $2, $3, 'Search', 'elasticsearch', 'active')",
            &[&service_id, &organization_id, &region],
        )
        .await
        .expect("insert backend_service");

    let identity = TenantIdentity::new(organization_id, resource_kind, service_id);
    let username = identity.username();
    let secret = generate_secret();

    client
        .execute(
            "insert into service_credential (id, backend_service_id, username, secret_hash, last_four)
             values ($1, $2, $3, $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &hash_generated_secret(&secret),
                &&secret[secret.len() - 4..],
            ],
        )
        .await
        .expect("insert service_credential");

    Tenant {
        username,
        secret,
        identity,
        fixtures: vec![user_id, organization_id],
    }
}

#[tokio::test]
async fn mget_cannot_name_another_tenants_index_and_refuses_unknown_fields() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let a = provision(&url).await;
    let b = provision(&url).await;
    let index = unique_index("mget-private");
    let (status, response) = as_tenant(
        address,
        &a,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some(("application/json", r#"{"owner":"tenant a secret"}"#.into())),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {response}");

    let victim = format!("{}{index}", prefix_for(&a.identity));
    let body = format!(r#"{{"docs":[{{"_index":"{victim}","_id":"1"}}]}}"#);
    let (status, response) = as_tenant(
        address,
        &b,
        reqwest::Method::POST,
        "/_mget",
        Some(("application/json", body)),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {response}");
    assert!(
        !response.contains("tenant a secret"),
        "cross-tenant read: {response}"
    );

    let (status, _) = as_tenant(
        address,
        &b,
        reqwest::Method::POST,
        "/_mget",
        Some((
            "application/json",
            r#"{"docs":[{"_index":"products","_id":"1","index":"victim"}]}"#.into(),
        )),
    )
    .await;
    assert_eq!(status, 400);

    cleanup(&url, &[&a, &b]).await;
}

#[tokio::test]
async fn query_parameters_cannot_override_the_scoped_path_or_body() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;
    for path in [
        "/_bulk?index=victim",
        "/_bulk?source=%7B%7D&source_content_type=application%2Fx-ndjson",
        "/products/_search?not_reviewed=true",
        "/products/_search?pretty=true&pretty=false",
    ] {
        let (status, body) = as_tenant(
            address,
            &tenant,
            reqwest::Method::POST,
            path,
            Some(("application/x-ndjson", "{}\n".into())),
        )
        .await;
        assert_eq!(status, 400, "{path} returned {status}: {body}");
    }

    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn tenant_b_cannot_search_with_tenant_as_point_in_time_handle() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let a = provision(&url).await;
    let b = provision(&url).await;
    let index = unique_index("pit-private");

    let (status, body) = as_tenant(
        address,
        &a,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some((
            "application/json",
            r#"{"owner":"tenant a pit secret"}"#.into(),
        )),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {body}");

    // Create the capability outside the proxy, exactly as though tenant B obtained tenant A's id
    // from a log or another compromised client. The proxy must reject use of the real handle, not
    // merely prevent B from creating a new one.
    let physical_index = format!("{}{index}", prefix_for(&a.identity));
    let created = admin_request(
        reqwest::Method::POST,
        &format!("/{physical_index}/_search/point_in_time?keep_alive=1m"),
    )
    .send()
    .await
    .expect("create tenant a PIT directly");
    let created_status = created.status();
    let created_body = created.text().await.unwrap_or_default();
    assert!(
        created_status.is_success(),
        "{created_status} {created_body}"
    );
    let pit_id = serde_json::from_str::<serde_json::Value>(&created_body)
        .expect("PIT response JSON")
        .get("pit_id")
        .and_then(serde_json::Value::as_str)
        .expect("PIT response id")
        .to_owned();

    for (path, content_type, request_body) in [
        (
            "/_search",
            "application/json",
            serde_json::json!({ "pit": { "id": pit_id, "keep_alive": "1m" } }).to_string(),
        ),
        (
            "/_msearch",
            "application/x-ndjson",
            format!(
                "{{}}\n{}\n",
                serde_json::json!({ "pit": { "id": pit_id, "keep_alive": "1m" } })
            ),
        ),
    ] {
        let (status, body) = as_tenant(
            address,
            &b,
            reqwest::Method::POST,
            path,
            Some((content_type, request_body)),
        )
        .await;
        assert_eq!(
            status, 403,
            "tenant B used tenant A's PIT at {path}: {body}"
        );
        assert!(
            body.contains("Point-in-time searches are not available"),
            "request may have reached OpenSearch instead of failing at the proxy: {body}"
        );
        assert!(
            !body.contains("tenant a pit secret"),
            "cross-tenant read: {body}"
        );
    }

    // Compression must not turn an inspected body into opaque bytes that OpenSearch decodes only
    // after the proxy has approved it. Reject the coding before forwarding regardless of payload.
    let compressed = reqwest::Client::new()
        .post(format!("http://{address}/_search"))
        .basic_auth(&b.username, Some(&b.secret))
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .body(serde_json::json!({ "pit": { "id": pit_id } }).to_string())
        .send()
        .await
        .expect("compressed PIT request");
    let compressed_status = compressed.status();
    let compressed_body = compressed.text().await.unwrap_or_default();
    assert_eq!(
        compressed_status.as_u16(),
        415,
        "compressed PIT body bypassed inspection: {compressed_body}"
    );
    assert!(
        compressed_body.contains("Compressed request bodies are not available"),
        "compressed body may have reached OpenSearch: {compressed_body}"
    );

    let deleted = admin_request(reqwest::Method::DELETE, "/_search/point_in_time")
        .json(&serde_json::json!({ "pit_id": [pit_id] }))
        .send()
        .await
        .expect("delete test PIT directly");
    let deleted_status = deleted.status();
    let deleted_body = deleted.text().await.unwrap_or_default();
    assert!(
        deleted_status.is_success(),
        "{deleted_status} {deleted_body}"
    );

    cleanup(&url, &[&a, &b]).await;
}

#[tokio::test]
async fn a_queue_credential_cannot_open_the_search_proxy() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision_kind(&url, ResourceKind::Queue).await;
    let (status, body) = as_tenant(address, &tenant, reqwest::Method::GET, "/_search", None).await;
    assert_eq!(status, 401, "a queue credential reached OpenSearch: {body}");

    cleanup(&url, &[&tenant]).await;
}

async fn cleanup(url: &str, tenants: &[&Tenant]) {
    let Ok((client, connection)) = tokio_postgres::connect(url, tokio_postgres::NoTls).await else {
        return;
    };
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for tenant in tenants {
        for id in &tenant.fixtures {
            let _ = client
                .execute("delete from organization where id = $1", &[id])
                .await;
            let _ = client
                .execute("delete from \"user\" where id = $1", &[id])
                .await;
        }
        let _ = admin_request(
            reqwest::Method::DELETE,
            &format!("/{}*", prefix_for(&tenant.identity)),
        )
        .send()
        .await;
        let role = format!(
            "tenant_{}",
            prefix_for(&tenant.identity).trim_end_matches('_')
        );
        for path in [
            format!("/_plugins/_security/api/internalusers/{}", tenant.username),
            format!("/_plugins/_security/api/rolesmapping/{role}"),
            format!("/_plugins/_security/api/roles/{role}"),
        ] {
            let _ = admin_request(reqwest::Method::DELETE, &path).send().await;
        }
    }
}

/// A request through the proxy, as a tenant.
async fn as_tenant(
    address: SocketAddr,
    tenant: &Tenant,
    method: reqwest::Method,
    path: &str,
    body: Option<(&'static str, String)>,
) -> (u16, String) {
    let mut request = reqwest::Client::new()
        .request(method, format!("http://{address}{path}"))
        .basic_auth(&tenant.username, Some(&tenant.secret));
    if let Some((content_type, body)) = body {
        request = request.header("content-type", content_type).body(body);
    }
    let response = request.send().await.expect("proxy request");
    let status = response.status().as_u16();
    (status, response.text().await.unwrap_or_default())
}

/// A name unique to this test run.
///
/// The cluster is shared and long-lived, so a fixed name means a stray index left by an earlier run
/// — or by a deliberately broken build — fails today's test for yesterday's reason. A unique name
/// keeps the assertion precise: *this* request must not have created an un-namespaced index.
fn unique_index(stem: &str) -> String {
    format!("{stem}-{}", Uuid::now_v7().simple())
}

/// A request straight to OpenSearch, bypassing the proxy — the only way to see what was actually
/// stored rather than what the proxy chose to show us.
async fn direct(path: &str) -> String {
    admin_request(reqwest::Method::GET, path)
        .send()
        .await
        .expect("upstream request")
        .text()
        .await
        .unwrap_or_default()
}

async fn refresh() {
    // OpenSearch indexes are near-real-time: without this a document just written is not yet
    // searchable, and the test would fail for a reason that is not the code's fault.
    let _ = admin_request(reqwest::Method::POST, "/_refresh")
        .send()
        .await;
}

fn admin_request(method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .request(method, format!("{}{path}", upstream()))
        .basic_auth(
            std::env::var("SEARCH_ADMIN_USER").unwrap_or_else(|_| "admin".into()),
            Some(
                std::env::var("SEARCH_ADMIN_PASSWORD")
                    .unwrap_or_else(|_| "L0cal!Windmill-Quartz-83".into()),
            ),
        )
}

/// A request straight to OpenSearch as the generated tenant user.
///
/// This deliberately bypasses every proxy route and rewrite. A denial here belongs to the engine's
/// Security plugin; a proxy bug cannot make the test pass by rejecting the request first.
async fn direct_as_tenant(
    tenant: &TenantSecurityIdentity,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> (u16, String) {
    let mut request = reqwest::Client::new()
        .request(method, format!("{}{path}", upstream()))
        .basic_auth(&tenant.user, Some(&tenant.password));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("direct tenant request");
    let status = response.status().as_u16();
    (status, response.text().await.unwrap_or_default())
}

#[tokio::test]
async fn opensearch_itself_enforces_the_tenant_boundary() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let a = provision(&url).await;
    let b = provision(&url).await;
    let manager = SecurityManager::new(
        reqwest::Client::new(),
        upstream(),
        std::env::var("SEARCH_PROXY_SECURITY_ROOT_KEY")
            .unwrap_or_else(|_| "local-search-security-root-key-32-bytes".into()),
    )
    .expect("security manager");
    let a_security = manager
        .ensure(&a.identity, &prefix_for(&a.identity))
        .await
        .expect("provision tenant a in OpenSearch");
    let b_security = manager
        .ensure(&b.identity, &prefix_for(&b.identity))
        .await
        .expect("provision tenant b in OpenSearch");

    let logical = unique_index("engine-boundary");
    let a_index = format!("{}{logical}", prefix_for(&a.identity));
    let b_index = format!("{}{logical}", prefix_for(&b.identity));
    for (security, index, marker) in [
        (&a_security, &a_index, "tenant a engine proof"),
        (&b_security, &b_index, "tenant b engine proof"),
    ] {
        let (status, body) = direct_as_tenant(
            security,
            reqwest::Method::PUT,
            &format!("/{index}/_doc/1?refresh=true"),
            Some(serde_json::json!({ "marker": marker, "tags": [marker] })),
        )
        .await;
        assert!((200..300).contains(&status), "{status} {body}");
    }

    // Positive control: these credentials are usable directly when the index belongs to them.
    let (status, body) = direct_as_tenant(
        &a_security,
        reqwest::Method::GET,
        &format!("/{a_index}/_search"),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("tenant a engine proof"), "{body}");

    // The physical foreign index name is presented directly to OpenSearch. No proxy is present to
    // rewrite it to tenant A's prefix, so only the engine's role can stop this read.
    let (status, body) = direct_as_tenant(
        &a_security,
        reqwest::Method::GET,
        &format!("/{b_index}/_search"),
        None,
    )
    .await;
    assert_eq!(status, 403, "foreign index returned {status}: {body}");
    assert!(
        !body.contains("tenant b engine proof"),
        "cross-tenant read: {body}"
    );

    // Terms lookup is an auxiliary read named inside the query body. It is the kind of path a
    // future proxy parser could miss, which is precisely why the engine boundary must exist.
    let (status, body) = direct_as_tenant(
        &a_security,
        reqwest::Method::POST,
        &format!("/{a_index}/_search"),
        Some(serde_json::json!({
            "query": {
                "terms": {
                    "marker": {
                        "index": b_index,
                        "id": "1",
                        "path": "tags"
                    }
                }
            }
        })),
    )
    .await;
    assert_eq!(
        status, 403,
        "foreign terms lookup returned {status}: {body}"
    );
    assert!(
        !body.contains("tenant b engine proof"),
        "cross-tenant read: {body}"
    );

    for (method, path) in [
        (reqwest::Method::GET, "/_cat/indices?format=json"),
        (reqwest::Method::GET, "/_cluster/health"),
        (
            reqwest::Method::GET,
            "/_plugins/_security/api/internalusers",
        ),
    ] {
        let (status, body) = direct_as_tenant(&a_security, method, path, None).await;
        assert_eq!(status, 403, "admin path {path} returned {status}: {body}");
    }

    cleanup(&url, &[&a, &b]).await;
}

#[tokio::test]
async fn two_tenants_cannot_see_each_others_indices() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let a = provision(&url).await;
    let b = provision(&url).await;

    // The same index name, written by both tenants, with different documents.
    let index = unique_index("products");
    let (status, body) = as_tenant(
        address,
        &a,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some(("application/json", r#"{"name":"tenant a widget"}"#.into())),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {body}");

    let (status, body) = as_tenant(
        address,
        &b,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some(("application/json", r#"{"name":"tenant b widget"}"#.into())),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {body}");

    refresh().await;

    // Neither sees the other's document. This is the whole product requirement.
    let search = format!("/{index}/_search");
    let (_, a_hits) = as_tenant(address, &a, reqwest::Method::GET, &search, None).await;
    assert!(a_hits.contains("tenant a widget"), "{a_hits}");
    assert!(
        !a_hits.contains("tenant b widget"),
        "cross-tenant read: {a_hits}"
    );

    let (_, b_hits) = as_tenant(address, &b, reqwest::Method::GET, &search, None).await;
    assert!(b_hits.contains("tenant b widget"), "{b_hits}");
    assert!(
        !b_hits.contains("tenant a widget"),
        "cross-tenant read: {b_hits}"
    );

    // And from outside the proxy: the un-namespaced index must not exist at all. A proxy that
    // forwarded one request unnamespaced would still pass the assertions above, because the tenant
    // that wrote it would read its own document back.
    let indices = direct("/_cat/indices?format=json").await;
    assert!(
        !indices.contains(&format!("\"index\":\"{index}\"")),
        "an un-namespaced index reached the cluster: {indices}"
    );
    assert!(
        indices.contains(&format!("{}{index}", prefix_for(&a.identity))),
        "{indices}"
    );
    assert!(
        indices.contains(&format!("{}{index}", prefix_for(&b.identity))),
        "{indices}"
    );

    cleanup(&url, &[&a, &b]).await;
}

#[tokio::test]
async fn a_search_response_does_not_leak_the_namespace() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;

    as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        "/orders/_doc/1?refresh=true",
        Some(("application/json", r#"{"total":42}"#.into())),
    )
    .await;
    refresh().await;

    let (_, body) = as_tenant(
        address,
        &tenant,
        reqwest::Method::GET,
        "/orders/_search",
        None,
    )
    .await;

    /*
      A client that reads `_index` out of a hit and sends it back — which is what any
      "reindex this document" flow does — would get it namespaced a second time.
    */
    assert!(body.contains("\"_index\":\"orders\""), "{body}");
    assert!(
        !body.contains(&prefix_for(&tenant.identity)),
        "the namespace leaked into the response: {body}"
    );

    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn a_cluster_wide_search_returns_only_this_tenants_documents() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let a = provision(&url).await;
    let b = provision(&url).await;

    for (tenant, marker) in [(&a, "alpha document"), (&b, "beta document")] {
        as_tenant(
            address,
            tenant,
            reqwest::Method::POST,
            "/notes/_doc/1?refresh=true",
            Some(("application/json", format!(r#"{{"body":"{marker}"}}"#))),
        )
        .await;
    }
    refresh().await;

    // `GET /_search` with no index means the whole cluster. It has to mean this tenant's indices.
    let (status, body) = as_tenant(address, &a, reqwest::Method::GET, "/_search", None).await;
    assert!((200..300).contains(&status), "{status} {body}");
    assert!(body.contains("alpha document"), "{body}");
    assert!(!body.contains("beta document"), "cross-tenant read: {body}");

    cleanup(&url, &[&a, &b]).await;
}

#[tokio::test]
async fn a_bulk_body_cannot_write_outside_the_namespace() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;

    // A bare `_bulk` takes its index per line, so the body is the only thing naming it.
    let index = unique_index("inventory");
    let body =
        format!("{{\"index\":{{\"_index\":\"{index}\",\"_id\":\"1\"}}}}\n{{\"sku\":\"abc\"}}\n");
    let (status, response) = as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        "/_bulk?refresh=true",
        Some(("application/x-ndjson", body)),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {response}");
    assert!(!response.contains("\"errors\":true"), "{response}");
    refresh().await;

    let (_, hits) = as_tenant(
        address,
        &tenant,
        reqwest::Method::GET,
        &format!("/{index}/_search"),
        None,
    )
    .await;
    assert!(hits.contains("abc"), "{hits}");

    // The bare name must not exist in the cluster.
    let indices = direct("/_cat/indices?format=json").await;
    assert!(
        !indices.contains(&format!("\"index\":\"{index}\"")),
        "a bulk body wrote outside the namespace: {indices}"
    );

    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn cluster_wide_endpoints_are_refused() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;

    // `_cat/indices` would list every tenant's indices; `_cluster/settings` reconfigures the
    // cluster for everyone on it.
    for path in [
        "/_cat/indices",
        "/_cluster/health",
        "/_nodes",
        "/_reindex",
        "/_aliases",
    ] {
        let (status, body) = as_tenant(address, &tenant, reqwest::Method::GET, path, None).await;
        assert_eq!(status, 403, "{path} returned {status}: {body}");
    }

    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn an_unauthenticated_request_reaches_nothing() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let response = reqwest::Client::new()
        .get(format!("http://{address}/_search"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
}

#[tokio::test]
async fn a_wrong_secret_is_refused_the_same_way_as_an_unknown_tenant() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;

    let wrong = reqwest::Client::new()
        .get(format!("http://{address}/_search"))
        .basic_auth(&tenant.username, Some("not-the-secret"))
        .send()
        .await
        .expect("request");
    let wrong_status = wrong.status().as_u16();
    let wrong_body = wrong.text().await.unwrap_or_default();

    // Any difference is an oracle for enumerating which tenants exist, one request at a time.
    let unknown = reqwest::Client::new()
        .get(format!("http://{address}/_search"))
        .basic_auth(
            "ix_00000000000000000000000000.00000000000000000000000000",
            Some("x"),
        )
        .send()
        .await
        .expect("request");
    assert_eq!(unknown.status().as_u16(), wrong_status);
    assert_eq!(unknown.text().await.unwrap_or_default(), wrong_body);

    cleanup(&url, &[&tenant]).await;
}

/// A deleted organization's credentials must stop working.
///
/// Deleting an organization soft-deletes the row and nothing else — it does not revoke the service
/// credentials underneath it. Without the organization join in `lib/rust/service-credentials`, a
/// deleted customer's search and queue credentials went on working indefinitely, which is a
/// customer who asked to be gone and was not.
///
/// Tested here rather than in both proxies because the lookup is shared: one test covers the code,
/// and two would drift.
#[tokio::test]
async fn a_deleted_organizations_credentials_stop_working() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;

    let (status, _) = as_tenant(address, &tenant, reqwest::Method::GET, "/_search", None).await;
    assert!(
        (200..300).contains(&status),
        "the credential should work first: {status}"
    );

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
        .execute(
            "update organization set deleted_at = now() where id = $1",
            &[&tenant.identity.organization_id],
        )
        .await
        .expect("soft-delete the organization");

    let (after, body) = as_tenant(address, &tenant, reqwest::Method::GET, "/_search", None).await;
    assert_eq!(
        after, 401,
        "a deleted organization still authenticated: {body}"
    );

    // Undo it so the shared cleanup can still reach the rows.
    let _ = client
        .execute(
            "update organization set deleted_at = null where id = $1",
            &[&tenant.identity.organization_id],
        )
        .await;
    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn a_deleted_internal_user_is_reprovisioned_after_one_upstream_401() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let tenant = provision(&url).await;
    let index = unique_index("security-recovery");
    let (status, body) = as_tenant(
        address,
        &tenant,
        reqwest::Method::POST,
        &format!("/{index}/_doc/1?refresh=true"),
        Some(("application/json", r#"{"recovered":true}"#.into())),
    )
    .await;
    assert!((200..300).contains(&status), "{status} {body}");

    admin_request(
        reqwest::Method::DELETE,
        &format!("/_plugins/_security/api/internalusers/{}", tenant.username),
    )
    .send()
    .await
    .expect("delete cached internal user");

    let (status, body) = as_tenant(
        address,
        &tenant,
        reqwest::Method::GET,
        &format!("/{index}/_doc/1"),
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("recovered"), "{body}");
    cleanup(&url, &[&tenant]).await;
}

#[tokio::test]
async fn a_second_upstream_401_is_not_retried() {
    let _serial = INTEGRATION.lock().await;
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    #[derive(Clone, Default)]
    struct Counts {
        tenant: Arc<AtomicUsize>,
        provisioning: Arc<AtomicUsize>,
    }
    async fn always_unauthorized(
        axum::extract::State(counts): axum::extract::State<Counts>,
        request: axum::extract::Request,
    ) -> axum::http::StatusCode {
        if request.uri().path().starts_with("/_plugins/_security/api/") {
            counts.provisioning.fetch_add(1, Ordering::SeqCst);
            axum::http::StatusCode::CREATED
        } else {
            counts.tenant.fetch_add(1, Ordering::SeqCst);
            axum::http::StatusCode::UNAUTHORIZED
        }
    }

    let counts = Counts::default();
    let mock = axum::Router::new()
        .fallback(axum::routing::any(always_unauthorized))
        .with_state(counts.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

    let address = start_proxy_at(&url, format!("http://{mock_address}")).await;
    let tenant = provision(&url).await;
    let (status, _) = as_tenant(address, &tenant, reqwest::Method::GET, "/_search", None).await;
    assert_eq!(status, 503);
    assert_eq!(counts.tenant.load(Ordering::SeqCst), 2);
    assert_eq!(counts.provisioning.load(Ordering::SeqCst), 6);
    cleanup(&url, &[&tenant]).await;
}
