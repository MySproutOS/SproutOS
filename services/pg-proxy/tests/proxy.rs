//! End to end: a real `tokio-postgres` client, through the proxy, into the compose Postgres.
//!
//! The unit tests prove the pieces — a startup packet parses, an identifier containing a semicolon
//! is refused, the derived names match the control plane's. None of them prove the pieces are wired
//! to each other, and the failure this service exists to prevent is a wiring failure: a session that
//! reached the splice still holding the proxy's administrative role would let one tenant read every
//! other tenant's tables.
//!
//! So this provisions two tenants with real databases and roles and checks from the outside that
//! neither can reach the other's — with a client library rather than hand-written bytes, because a
//! hand-written client would only prove the proxy agrees with my reading of the protocol.
//!
//! Skipped on a developer's machine when Postgres is not running. **Failed in CI**: a skipped
//! isolation test reads exactly like a passing one.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use pg_proxy::{BackendConfig, serve_connection};
use sproutos_service_credentials::CredentialStore;
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

fn database_url() -> Option<String> {
    std::env::var("PG_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .map(|url| url.split('?').next().unwrap_or(&url).to_owned())
}

fn backend_config() -> BackendConfig {
    BackendConfig {
        host: std::env::var("PG_PROXY_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("PG_PROXY_BACKEND_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(25281),
        user: std::env::var("PG_PROXY_BACKEND_USER").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("PG_PROXY_BACKEND_PASSWORD").unwrap_or_else(|_| "postgres".into()),
    }
}

async fn services_up(url: &str) -> bool {
    let postgres = match CredentialStore::connect(url, 2) {
        Ok(store) => store.check().await.is_ok(),
        Err(_) => false,
    };

    if !postgres && std::env::var("CI").is_ok() {
        panic!("postgres is not reachable in CI; these tests must not silently skip here");
    }
    if !postgres {
        eprintln!("skipping: run `docker compose up -d` and apply migrations first");
    }
    postgres
}

async fn admin(url: &str) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect to postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

/// A provisioned tenant: the credential it connects with, and where it should land.
struct Tenant {
    username: String,
    secret: String,
    database: String,
    role: String,
    fixtures: Vec<Uuid>,
}

/// Create the control-plane rows *and* the real database and role.
///
/// Both halves matter. The rows are what the proxy authenticates against; the database and role are
/// what it routes to. Provisioning only the first would fail every test at the backend for a reason
/// unrelated to what is being tested.
async fn provision(url: &str) -> Tenant {
    let client = admin(url).await;

    let user_id = Uuid::now_v7();
    let organization_id = Uuid::now_v7();
    let service_id = Uuid::now_v7();

    client
        .execute(
            "insert into \"user\" (id, email, name) values ($1, $2, 'PG Proxy Test')",
            &[&user_id, &format!("pgproxy-{user_id}@test.invalid")],
        )
        .await
        .expect("insert user");
    client
        .execute(
            "insert into organization (id, name, slug, kind, owner_user_id)
             values ($1, 'PG Proxy Org', $2, 'personal', $3)",
            &[
                &organization_id,
                &format!("pgproxy-{organization_id}"),
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
             values ($1, $2, $3, 'PG Proxy DB', 'postgres', 'active')",
            &[&service_id, &organization_id, &region],
        )
        .await
        .expect("insert backend_service");

    let identity = sproutos_tenant_auth::TenantIdentity::new(
        organization_id,
        sproutos_tenant_auth::ResourceKind::Database,
        service_id,
    );
    let username = identity.username();
    let secret = sproutos_tenant_auth::generate_secret();

    client
        .execute(
            "insert into service_credential (id, backend_service_id, username, secret_hash, last_four)
             values ($1, $2, $3, $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &sproutos_tenant_auth::hash_generated_secret(&secret),
                &&secret[secret.len() - 4..],
            ],
        )
        .await
        .expect("insert service_credential");

    // The real database and role, named exactly as `routing.rs` derives them. In production this is
    // `lib/typescript/services/src/postgres.ts`; doing it here with the same names is what makes the
    // cross-language agreement testable rather than assumed.
    let database = pg_proxy::routing::database_for(&identity);
    let role = pg_proxy::routing::role_for(&identity);

    /*
        Two statements, not one `batch_execute`.

        `batch_execute` sends them as a single simple-query message, which Postgres wraps in an
        implicit transaction — and `CREATE DATABASE` refuses to run inside one. The error names
        `PreventInTransactionBlock`, which is not obviously about batching.
    */
    client
        .execute(&format!("create role {role} nologin"), &[])
        .await
        .expect("create role");
    client
        .execute(&format!("create database {database} owner {role}"), &[])
        .await
        .expect("create database");

    Tenant {
        username,
        secret,
        database,
        role,
        fixtures: vec![organization_id, user_id],
    }
}

async fn cleanup(url: &str, tenant: &Tenant) {
    let client = admin(url).await;
    // Same reason as above: `DROP DATABASE` cannot run inside a transaction block either.
    let _ = client
        .execute(
            &format!("drop database if exists {} with (force)", tenant.database),
            &[],
        )
        .await;
    let _ = client
        .execute(&format!("drop role if exists {}", tenant.role), &[])
        .await;
    for id in &tenant.fixtures {
        let _ = client
            .execute("delete from organization where id = $1", &[id])
            .await;
        let _ = client
            .execute("delete from \"user\" where id = $1", &[id])
            .await;
    }
}

/// Start the proxy on an ephemeral port.
async fn start_proxy(url: &str) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");

    let store = Arc::new(CredentialStore::connect(url, 2).expect("store"));
    let backend = backend_config();

    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let store = Arc::clone(&store);
            let backend = backend.clone();
            tokio::spawn(async move {
                // Printed, not discarded. A proxy that refuses a connection for a reason the test
                // cannot see turns every failure into "Closed", which says nothing.
                if let Err(cause) = serve_connection(client, store, backend).await {
                    eprintln!("pg-proxy session ended: {cause}");
                }
            });
        }
    });

    address
}

async fn connect_through(
    address: SocketAddr,
    username: &str,
    password: &str,
) -> Result<tokio_postgres::Client, tokio_postgres::Error> {
    let config = format!(
        "host={} port={} user={} password={} dbname=ignored",
        address.ip(),
        address.port(),
        username,
        password
    );

    let (client, connection) = tokio_postgres::connect(&config, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

#[tokio::test]
async fn a_tenant_lands_in_its_own_database_as_its_own_role() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let tenant = provision(&url).await;
    let address = start_proxy(&url).await;

    let client = connect_through(address, &tenant.username, &tenant.secret)
        .await
        .expect("the proxy should accept a live credential");

    /*
        The two facts that matter, asked of the session itself.

        `current_database()` proves the routing: the client asked for `dbname=ignored` and the proxy
        substituted the database derived from the credential. `current_user` proves the privilege
        drop — without `SET ROLE` this says `postgres`, and every tenant is an administrator on a
        cluster holding every other tenant's data.
    */
    let row = client
        .query_one("select current_database(), current_user::text", &[])
        .await
        .expect("query");

    let database: String = row.get(0);
    let role: String = row.get(1);

    assert_eq!(database, tenant.database);
    assert_eq!(role, tenant.role);

    cleanup(&url, &tenant).await;
}

#[tokio::test]
async fn one_tenant_cannot_reach_another_tenants_database() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let first = provision(&url).await;
    let second = provision(&url).await;
    let address = start_proxy(&url).await;

    let client = connect_through(address, &first.username, &first.secret)
        .await
        .expect("connect");

    client
        .batch_execute("create table secrets (value text); insert into secrets values ('first');")
        .await
        .expect("the tenant should own its own database");

    let other = connect_through(address, &second.username, &second.secret)
        .await
        .expect("connect");

    let database: String = other
        .query_one("select current_database()", &[])
        .await
        .expect("query")
        .get(0);
    assert_eq!(database, second.database);
    assert_ne!(database, first.database);

    /*
        And the first tenant's table is not visible at all.

        Postgres has no cross-database reference without dblink, so this is the strong form: the
        second tenant's catalogue does not contain it. What this guards is a proxy that ignored the
        database derived from the credential and used the one the client asked for.
    */
    let count: i64 = other
        .query_one(
            "select count(*) from pg_tables where tablename = 'secrets'",
            &[],
        )
        .await
        .expect("query")
        .get(0);
    assert_eq!(
        count, 0,
        "the second tenant can see the first tenant's table"
    );

    cleanup(&url, &first).await;
    cleanup(&url, &second).await;
}

#[tokio::test]
async fn a_wrong_secret_is_refused() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let tenant = provision(&url).await;
    let address = start_proxy(&url).await;

    let refused = connect_through(address, &tenant.username, "not-the-secret").await;
    assert!(refused.is_err(), "a wrong secret should not connect");

    cleanup(&url, &tenant).await;
}

/// Provision a **queue** credential: a real, live row the store will happily authenticate.
///
/// This is the fixture that makes the kind check testable. The first version of this test just
/// rewrote `db_` to `kv_` in a database credential's username — which matches no row, so the store
/// refused it before the kind check was ever reached, and the test passed with the check deleted.
async fn provision_queue_credential(url: &str) -> (String, String, Vec<Uuid>) {
    let client = admin(url).await;

    let user_id = Uuid::now_v7();
    let organization_id = Uuid::now_v7();
    let service_id = Uuid::now_v7();

    client
        .execute(
            "insert into \"user\" (id, email, name) values ($1, $2, 'PG Proxy Queue Test')",
            &[&user_id, &format!("pgqueue-{user_id}@test.invalid")],
        )
        .await
        .expect("insert user");
    client
        .execute(
            "insert into organization (id, name, slug, kind, owner_user_id)
             values ($1, 'PG Proxy Queue Org', $2, 'personal', $3)",
            &[
                &organization_id,
                &format!("pgqueue-{organization_id}"),
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
             values ($1, $2, $3, 'PG Proxy Queue', 'valkey', 'active')",
            &[&service_id, &organization_id, &region],
        )
        .await
        .expect("insert backend_service");

    let identity = sproutos_tenant_auth::TenantIdentity::new(
        organization_id,
        sproutos_tenant_auth::ResourceKind::Queue,
        service_id,
    );
    let username = identity.username();
    let secret = sproutos_tenant_auth::generate_secret();

    client
        .execute(
            "insert into service_credential (id, backend_service_id, username, secret_hash, last_four)
             values ($1, $2, $3, $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &sproutos_tenant_auth::hash_generated_secret(&secret),
                &&secret[secret.len() - 4..],
            ],
        )
        .await
        .expect("insert service_credential");

    /*
        And the database the derived name would point at, created deliberately.

        Without this the connection fails anyway — at the backend, because `sprout_db_<queue-id>`
        does not exist — and the test passes with the kind check deleted. It took two attempts to
        notice: the first version rewrote a username and never reached the store, the second reached
        the store and never reached the backend.

        Creating it is contrived, and that is the point. It removes every *other* reason this
        connection could fail, so what the assertion measures is the kind check and nothing else.
        The honest reading of the result is that the check is defence in depth: resource ids differ
        between a tenant's queue and their database, so the derived names already diverge. This is
        what holds if that ever stops being true.
    */
    let database = pg_proxy::routing::database_for(&identity);
    let role = pg_proxy::routing::role_for(&identity);
    client
        .execute(&format!("create role {role} nologin"), &[])
        .await
        .expect("create role");
    client
        .execute(&format!("create database {database} owner {role}"), &[])
        .await
        .expect("create database");

    (username, secret, vec![organization_id, user_id])
}

#[tokio::test]
async fn a_queue_credential_cannot_open_a_database_connection() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let (username, secret, fixtures) = provision_queue_credential(&url).await;
    let address = start_proxy(&url).await;

    /*
        A tenant's real Valkey credential, pointed at the Postgres endpoint.

        The username grammar is shared across all three proxies and this row is live, so the
        credential store authenticates it — as it should; the store does not know which proxy is
        asking. What refuses it is the resource-kind check in `authenticate`. Without that, this
        connection would be routed to a database derived from a *queue's* resource id.
    */
    let refused = connect_through(address, &username, &secret).await;
    assert!(
        refused.is_err(),
        "a queue credential should not open a database connection"
    );

    let client = admin(&url).await;
    let identity = sproutos_tenant_auth::TenantIdentity::parse_username(&username).expect("parse");
    let _ = client
        .execute(
            &format!(
                "drop database if exists {} with (force)",
                pg_proxy::routing::database_for(&identity)
            ),
            &[],
        )
        .await;
    let _ = client
        .execute(
            &format!(
                "drop role if exists {}",
                pg_proxy::routing::role_for(&identity)
            ),
            &[],
        )
        .await;
    for id in &fixtures {
        let _ = client
            .execute("delete from organization where id = $1", &[id])
            .await;
        let _ = client
            .execute("delete from \"user\" where id = $1", &[id])
            .await;
    }
}

#[tokio::test]
async fn an_ssl_request_is_answered_rather_than_ignored() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let mut stream = TcpStream::connect(address).await.expect("connect");

    // Length 8, then the SSLRequest magic. Every libpq client sends this first unless
    // `sslmode=disable`, and a proxy that did not answer would hang every one of them.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(&8i32.to_be_bytes()).await.expect("write");
    stream
        .write_all(&80_877_103i32.to_be_bytes())
        .await
        .expect("write");
    stream.flush().await.expect("flush");

    let mut reply = [0u8; 1];
    tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut reply))
        .await
        .expect("the proxy did not answer the SSL request")
        .expect("read");

    assert_eq!(&reply, b"N", "the proxy should decline TLS, not hang");
}
