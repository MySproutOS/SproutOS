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

use search_proxy::naming::prefix_for;
use search_proxy::{Proxy, handle};
use sproutos_service_credentials::CredentialStore;
use sproutos_tenant_auth::{ResourceKind, TenantIdentity, generate_secret, hash_generated_secret};
use uuid::Uuid;

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
        .map(|response| response.status().is_success())
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
    let store = Arc::new(CredentialStore::connect(url, 4).expect("credential store"));
    let proxy = Arc::new(Proxy {
        store,
        upstream: upstream(),
        client: reqwest::Client::new(),
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

struct Tenant {
    username: String,
    secret: String,
    identity: TenantIdentity,
    fixtures: Vec<Uuid>,
}

/// Provisions a tenant in the control-plane database.
async fn provision(url: &str) -> Tenant {
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

    let identity = TenantIdentity::new(organization_id, ResourceKind::SearchIndex, service_id);
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
        let _ = reqwest::Client::new()
            .delete(format!("{}/{}*", upstream(), prefix_for(&tenant.identity)))
            .send()
            .await;
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
    reqwest::Client::new()
        .get(format!("{}{path}", upstream()))
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
    let _ = reqwest::Client::new()
        .post(format!("{}/_refresh", upstream()))
        .send()
        .await;
}

#[tokio::test]
async fn two_tenants_cannot_see_each_others_indices() {
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
