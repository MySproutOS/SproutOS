//! End to end: a real client, through the proxy, to the real Valkey in docker-compose.
//!
//! The unit tests prove each piece in isolation — that `BLPOP`'s timeout is not a key, that a map
//! reply is measured as pairs. None of them prove the pieces are wired to each other, and the
//! failure this service exists to prevent is a wiring failure: a key that reaches the shared
//! keyspace unprefixed is a key every other tenant can read.
//!
//! So this drives the whole thing. It provisions two tenants against the compose Postgres, has
//! each write to the same key name, and checks that neither can see the other's value — and it
//! checks it *from the outside*, by looking at the raw keys the backend actually holds.
//!
//! Skipped, not failed, when the services are not running: `docker compose up -d` first.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;
use valkey_proxy::CredentialStore;
use valkey_proxy::master::MasterQueue;

/// The shared Valkey these tests proxy to.
///
/// Defaults to the docker-compose port so a developer needs no setup beyond `docker compose up -d`.
/// CI overrides it, because a workflow's service containers pick their own mapping.
fn backend() -> String {
    std::env::var("VALKEY_PROXY_BACKEND").unwrap_or_else(|_| "127.0.0.1:41023".into())
}

fn database_url() -> Option<String> {
    // The same URL the TypeScript side uses. Read from the environment rather than hard-coded so
    // this runs against whatever the developer's compose stack is bound to.
    std::env::var("VALKEY_PROXY_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .map(|url| url.split('?').next().unwrap_or(&url).to_owned())
}

async fn services_up(url: &str) -> bool {
    let valkey = TcpStream::connect(backend()).await.is_ok();
    let postgres = match CredentialStore::connect(url, 2) {
        Ok(store) => store.check().await.is_ok(),
        Err(_) => false,
    };

    /*
      On a developer's machine a missing service is a skip: `cargo test` should not fail because
      docker is not running.

      In CI it is a failure. A skipped isolation test looks exactly like a passing one in the
      summary, so a workflow that lost its service container would go on reporting green while the
      tests that check tenants cannot read each other's keys had stopped running entirely.
    */
    if (!valkey || !postgres) && std::env::var("CI").is_ok() {
        panic!(
            "the integration services are not reachable in CI (valkey={valkey}, postgres={postgres}); \
             these tests must not silently skip here"
        );
    }

    if !valkey || !postgres {
        eprintln!("skipping: run `docker compose up -d` and apply migrations first");
    }
    valkey && postgres
}

/// A client that speaks just enough RESP to drive the proxy.
struct Client {
    stream: TcpStream,
}

impl Client {
    async fn connect(address: SocketAddr) -> Self {
        Self {
            stream: TcpStream::connect(address).await.expect("connect"),
        }
    }

    async fn send(&mut self, args: &[&str]) -> String {
        let mut out = format!("*{}\r\n", args.len());
        for arg in args {
            out.push_str(&format!("${}\r\n{arg}\r\n", arg.len()));
        }
        self.stream.write_all(out.as_bytes()).await.expect("write");

        let mut buffer = vec![0u8; 8192];
        let read = tokio::time::timeout(Duration::from_secs(5), self.stream.read(&mut buffer))
            .await
            .expect("the proxy did not reply in time")
            .expect("read");
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    }
}

/// Provisions a tenant in the control-plane database and returns its username and secret.
///
/// Written with raw SQL rather than through the TypeScript driver on purpose: this is the Rust side
/// reading rows the TypeScript side writes, and the point is to prove the two agree on the format.
async fn provision(url: &str) -> (String, String, Uuid, Vec<Uuid>) {
    provision_in(url, None).await
}

/// Provisions a tenant, optionally inside an organization that already exists.
async fn provision_in(url: &str, existing_org: Option<Uuid>) -> (String, String, Uuid, Vec<Uuid>) {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect to postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let user_id = Uuid::now_v7();
    let service_id = Uuid::now_v7();
    let mut fixtures = Vec::new();

    let organization_id = match existing_org {
        Some(id) => id,
        None => {
            let organization_id = Uuid::now_v7();
            client
                .execute(
                    "insert into \"user\" (id, email, name) values ($1, $2, 'Proxy Test')",
                    &[&user_id, &format!("proxy-{user_id}@test.invalid")],
                )
                .await
                .expect("insert user");
            client
                .execute(
                    "insert into organization (id, name, slug, kind, owner_user_id)
                     values ($1, 'Proxy Org', $2, 'personal', $3)",
                    &[
                        &organization_id,
                        &format!("proxy-{organization_id}"),
                        &user_id,
                    ],
                )
                .await
                .expect("insert organization");
            fixtures.push(organization_id);
            fixtures.push(user_id);
            organization_id
        }
    };

    let region: Uuid = client
        .query_one("select id from region limit 1", &[])
        .await
        .expect("a seeded region")
        .get(0);

    client
        .execute(
            "insert into backend_service (id, organization_id, region_id, name, kind, status)
             values ($1, $2, $3, 'Proxy Queue', 'valkey', 'active')",
            &[&service_id, &organization_id, &region],
        )
        .await
        .expect("insert backend_service");

    // The username and secret are built here the way `lib/typescript/services/tenant-auth.ts`
    // builds them. If the two encodings ever drift, this test cannot authenticate.
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

    (username, secret, service_id, fixtures)
}

async fn cleanup(url: &str, ids: &[Uuid]) {
    let Ok((client, connection)) = tokio_postgres::connect(url, tokio_postgres::NoTls).await else {
        return;
    };
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for id in ids {
        let _ = client
            .execute("delete from organization where id = $1", &[id])
            .await;
        let _ = client
            .execute("delete from \"user\" where id = $1", &[id])
            .await;
    }
}

/// Starts the proxy with the master queue enabled, so enqueues are reported for dispatch.
async fn start_proxy_with_master(url: &str) -> SocketAddr {
    start(url, MasterQueue::spawn(backend())).await
}

/// Starts the proxy on an ephemeral port and returns its address.
async fn start_proxy(url: &str) -> SocketAddr {
    start(url, MasterQueue::disabled()).await
}

async fn start(url: &str, master: MasterQueue) -> SocketAddr {
    let store = std::sync::Arc::new(CredentialStore::connect(url, 4).expect("credential store"));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("local_addr");
    // A `String`, matching what `serve` now takes. The proxy resolves it per connection, so a
    // DNS name works here exactly as it does in production — which a `SocketAddr` never did.
    let backend = std::sync::Arc::new(backend());
    let master = std::sync::Arc::new(master);

    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let store = std::sync::Arc::clone(&store);
            let backend = std::sync::Arc::clone(&backend);
            let master = std::sync::Arc::clone(&master);
            tokio::spawn(async move {
                let _ = valkey_proxy::serve(client, &backend, &store, &master).await;
            });
        }
    });

    address
}

/// Reads a key straight from the backend, bypassing the proxy — the only way to see what was
/// actually stored rather than what the proxy chose to show us.
async fn backend_get(key: &str) -> String {
    let mut raw = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    raw.send(&["GET", key]).await
}

#[tokio::test]
async fn two_tenants_cannot_see_each_others_keys() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, service_a, fixtures_a) = provision(&url).await;
    let (username_b, secret_b, service_b, fixtures_b) = provision(&url).await;

    let mut a = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");

    let mut b = Client::connect(address).await;
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    // The same key name, written by both tenants, with different values.
    assert_eq!(a.send(&["SET", "shared:key", "from-a"]).await, "+OK\r\n");
    assert_eq!(b.send(&["SET", "shared:key", "from-b"]).await, "+OK\r\n");

    // Neither sees the other's write. This is the whole product requirement.
    assert_eq!(a.send(&["GET", "shared:key"]).await, "$6\r\nfrom-a\r\n");
    assert_eq!(b.send(&["GET", "shared:key"]).await, "$6\r\nfrom-b\r\n");

    // And from outside the proxy: the unprefixed key must not exist at all. A proxy that forwarded
    // one command unnamespaced would still pass the two assertions above, because the tenant that
    // wrote it would read its own value back.
    assert_eq!(backend_get("shared:key").await, "$-1\r\n");

    let prefix_a = format!(
        "{{kv:{}}}:",
        sproutos_tenant_auth::encode_short_id(service_a)
    );
    let prefix_b = format!(
        "{{kv:{}}}:",
        sproutos_tenant_auth::encode_short_id(service_b)
    );
    assert_eq!(
        backend_get(&format!("{prefix_a}shared:key")).await,
        "$6\r\nfrom-a\r\n"
    );
    assert_eq!(
        backend_get(&format!("{prefix_b}shared:key")).await,
        "$6\r\nfrom-b\r\n"
    );

    // Tidy up the tenant's keys, then the fixtures.
    a.send(&["DEL", "shared:key"]).await;
    b.send(&["DEL", "shared:key"]).await;
    cleanup(&url, &fixtures_a).await;
    cleanup(&url, &fixtures_b).await;
}

#[tokio::test]
async fn a_blocking_pop_returns_the_key_the_tenant_asked_for() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    client.send(&["RPUSH", "bull:emails:wait", "job-1"]).await;

    /*
      The leak this test exists for.

      BLPOP echoes the key it popped from, and the key the *server* saw is the namespaced one. Sent
      back byte for byte, the tenant reads `{kv:…}:bull:emails:wait` out of the reply — and BullMQ
      does read it — then sends it as the next command's key, where it is namespaced a second time.
      The queue silently splits in two and jobs stop being delivered.
    */
    let reply = client.send(&["BLPOP", "bull:emails:wait", "0"]).await;
    assert_eq!(reply, "*2\r\n$16\r\nbull:emails:wait\r\n$5\r\njob-1\r\n");
    assert!(
        !reply.contains("{kv:"),
        "the namespace leaked into the reply: {reply}"
    );

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_wrong_secret_is_refused_and_reveals_nothing() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, _secret, _service, fixtures) = provision(&url).await;

    let mut wrong = Client::connect(address).await;
    let refused = wrong.send(&["AUTH", &username, "not-the-secret"]).await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    // A username that does not exist must be refused identically. Any difference — a distinct
    // message, a distinct error code — is an oracle for enumerating which tenants exist.
    let mut unknown = Client::connect(address).await;
    let missing = unknown
        .send(&[
            "AUTH",
            "kv_00000000000000000000000000.00000000000000000000000000",
            "x",
        ])
        .await;
    assert_eq!(missing, refused);

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn an_unauthenticated_connection_can_do_nothing() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let mut client = Client::connect(address).await;

    // No AUTH. Nothing must reach the backend — not a read, not a write, and above all not a
    // command that would touch the shared root of the keyspace.
    let reply = client.send(&["GET", "shared:key"]).await;
    assert!(reply.starts_with("-ERR NOAUTH"), "{reply}");
}

#[tokio::test]
async fn a_revoked_credential_stops_working_immediately() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut before = Client::connect(address).await;
    assert_eq!(before.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
        .execute(
            "update service_credential set revoked_at = now() where username = $1",
            &[&username],
        )
        .await
        .expect("revoke");

    // No cache, so no grace period. Rotation exists to recover from a leaked credential, and a
    // leaked credential that keeps working for another few seconds has not been recovered from.
    let mut after = Client::connect(address).await;
    let refused = after.send(&["AUTH", &username, &secret]).await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    cleanup(&url, &fixtures).await;
}

#[tokio::test]
async fn a_refused_command_does_not_end_the_connection() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, secret, _service, fixtures) = provision(&url).await;

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    // KEYS would enumerate every tenant's keyspace. Refused — but the connection has to survive it,
    // or one stray command from a library takes a worker down.
    let refused = client.send(&["KEYS", "*"]).await;
    assert!(refused.starts_with("-ERR"), "{refused}");
    assert_eq!(client.send(&["PING"]).await, "+PONG\r\n");

    cleanup(&url, &fixtures).await;
}

/// Two queues owned by the *same* organization.
///
/// The obvious tenancy design is one prefix per customer, and it is wrong: a customer with a queue
/// for emails and a queue for video encoding would find both writing `bull:jobs:wait` into the same
/// place. The prefix is per *resource*, and this is the test that says so.
#[tokio::test]
async fn two_queues_in_one_organization_are_separate() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username_a, secret_a, service_a, fixtures) = provision(&url).await;

    // Same organization, second service.
    let organization_id = {
        let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
            .await
            .expect("postgres");
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let row = client
            .query_one(
                "select organization_id from backend_service where id = $1",
                &[&service_a],
            )
            .await
            .expect("the first service");
        row.get::<_, Uuid>(0)
    };
    let (username_b, secret_b, service_b, _) = provision_in(&url, Some(organization_id)).await;

    assert_ne!(service_a, service_b);

    let mut a = Client::connect(address).await;
    assert_eq!(a.send(&["AUTH", &username_a, &secret_a]).await, "+OK\r\n");
    let mut b = Client::connect(address).await;
    assert_eq!(b.send(&["AUTH", &username_b, &secret_b]).await, "+OK\r\n");

    a.send(&["SET", "bull:jobs:wait", "emails"]).await;
    b.send(&["SET", "bull:jobs:wait", "video"]).await;

    assert_eq!(a.send(&["GET", "bull:jobs:wait"]).await, "$6\r\nemails\r\n");
    assert_eq!(b.send(&["GET", "bull:jobs:wait"]).await, "$5\r\nvideo\r\n");

    a.send(&["DEL", "bull:jobs:wait"]).await;
    b.send(&["DEL", "bull:jobs:wait"]).await;
    cleanup(&url, &fixtures).await;
}

/*
  TASK 20's second half, end to end against a real Valkey.

  > We use a proxy that receives valkey commands and adds it to a master valkey queue such that this
  > proxy consumer continuously receives jobs from all projects and spins up services as needed.

  The unit tests cover which verbs count as an enqueue and how a queue name is read out of a key.
  What they cannot cover is the part that was actually hard: the report reaches the backend on a
  connection of its own, because putting an extra command on the client's connection would leave a
  reply in the stream that nothing is waiting for, and every reply after it would be attributed to
  the wrong request. That is only observable against a server, which is why the last two assertions
  here are about the *client's* replies rather than about the master queue at all.
*/
#[tokio::test]
async fn an_enqueue_is_reported_to_the_master_queue() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    // A clean slate, so what is asserted below is what this test put there.
    let mut raw = Client {
        stream: TcpStream::connect(backend()).await.expect("backend"),
    };
    raw.send(&["DEL", "sproutos:master:wake"]).await;

    let address = start_proxy_with_master(&url).await;
    let (username, secret, service_id, fixtures) = provision(&url).await;

    let mut client = Client::connect(address).await;
    assert_eq!(client.send(&["AUTH", &username, &secret]).await, "+OK\r\n");

    // An enqueue, and a read that must not be mistaken for one.
    assert_eq!(
        client.send(&["LPUSH", "bull:emails:wait", "job-1"]).await,
        ":1\r\n"
    );
    client
        .send(&["LRANGE", "bull:reports:wait", "0", "-1"])
        .await;

    // The writer batches for a second before it writes.
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;

    let members = raw
        .send(&["ZRANGE", "sproutos:master:wake", "0", "-1"])
        .await;

    let expected = format!(
        "{}/emails",
        sproutos_tenant_auth::encode_short_id(service_id)
    );
    assert!(
        members.contains(&expected),
        "expected the enqueued queue in the master set, got {members}"
    );
    assert!(
        !members.contains("reports"),
        "a read must not wake a queue, got {members}"
    );

    /*
      And the client's own replies are still correctly ordered.

      This is the assertion the separate connection exists for. If the master queue's `ZADD` went
      out on this connection, its reply would arrive here and `PING` would return the `ZADD` result.
    */
    assert_eq!(client.send(&["PING"]).await, "+PONG\r\n");
    assert_eq!(client.send(&["LLEN", "bull:emails:wait"]).await, ":1\r\n");

    raw.send(&["DEL", "sproutos:master:wake"]).await;
    cleanup(&url, &fixtures).await;
}

/*
  Two live credentials for one username, both accepted.

  A worker the platform starts on a customer's behalf needs its own secret: the platform cannot reuse
  the customer's, which is stored as a hash, and until `service_credential.purpose` existed it could
  not issue a second either — one live credential per username was the constraint, and the username
  is derived from the resource so every credential for one service collides.

  This is the property the proxy has to hold up for that to work. There was a `limit 1` in the
  lookup, which meant whichever row came back first was the only secret that could ever authenticate
  — and *which* row that was depended on the plan. A worker would have worked, intermittently.
*/
#[tokio::test]
async fn a_service_may_have_a_tenant_and_a_worker_credential() {
    let Some(url) = database_url() else { return };
    if !services_up(&url).await {
        return;
    }

    let address = start_proxy(&url).await;
    let (username, tenant_secret, service_id, fixtures) = provision(&url).await;

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("postgres");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    // A second credential, same username, different purpose — exactly what `issueWorkerCredential`
    // writes.
    let worker_secret = sproutos_tenant_auth::generate_secret();
    client
        .execute(
            "insert into service_credential
               (id, backend_service_id, username, purpose, secret_hash, last_four)
             values ($1, $2, $3, 'worker', $4, $5)",
            &[
                &Uuid::now_v7(),
                &service_id,
                &username,
                &sproutos_tenant_auth::hash_generated_secret(&worker_secret),
                &&worker_secret[worker_secret.len() - 4..],
            ],
        )
        .await
        .expect("insert worker credential");

    // Both authenticate.
    let mut tenant = Client::connect(address).await;
    assert_eq!(
        tenant.send(&["AUTH", &username, &tenant_secret]).await,
        "+OK\r\n"
    );

    let mut worker = Client::connect(address).await;
    assert_eq!(
        worker.send(&["AUTH", &username, &worker_secret]).await,
        "+OK\r\n"
    );

    // And they land in the same keyspace, which is the point: a worker consumes the queue its
    // tenant fills.
    assert_eq!(
        tenant.send(&["SET", "shared", "from-tenant"]).await,
        "+OK\r\n"
    );
    assert_eq!(
        worker.send(&["GET", "shared"]).await,
        "$11\r\nfrom-tenant\r\n"
    );

    // Revoking the worker's leaves the customer's working. That separation is the whole reason for
    // two credentials rather than one shared secret.
    client
        .execute(
            "update service_credential set revoked_at = now()
             where username = $1 and purpose = 'worker'",
            &[&username],
        )
        .await
        .expect("revoke worker");

    let mut after_worker = Client::connect(address).await;
    let refused = after_worker
        .send(&["AUTH", &username, &worker_secret])
        .await;
    assert!(refused.starts_with("-ERR WRONGPASS"), "{refused}");

    let mut after_tenant = Client::connect(address).await;
    assert_eq!(
        after_tenant
            .send(&["AUTH", &username, &tenant_secret])
            .await,
        "+OK\r\n"
    );

    cleanup(&url, &fixtures).await;
}
